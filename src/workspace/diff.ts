import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { PixiuError } from "../shared/errors"
import { isInside } from "../sandbox/path"

export type WorkspaceDiffStatus = "added" | "deleted" | "modified" | "type-changed"
export type WorkspaceEntryKind = "file" | "symlink"
export type WorkspaceDiffLineKind = "context" | "add" | "delete"

export type WorkspaceDiffLine = {
  kind: WorkspaceDiffLineKind
  text: string
  oldLine: number
  newLine: number
}

export type WorkspaceDiffHunk = {
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  additions: number
  deletions: number
  lines: WorkspaceDiffLine[]
  patch: string
}

export type StructuredWorkspaceFileDiff = {
  path: string
  status: WorkspaceDiffStatus
  oldKind?: WorkspaceEntryKind
  newKind?: WorkspaceEntryKind
  oldHash?: string
  newHash?: string
  oldMode?: string
  newMode?: string
  oldSize?: number
  newSize?: number
  binary: boolean
  unsafeSymlink: boolean
  additions: number
  deletions: number
  hunks: WorkspaceDiffHunk[]
  hunksUnavailableReason?: "binary" | "too-large" | "type-changed"
  oldHasFinalNewline?: boolean
  newHasFinalNewline?: boolean
}

export type StructuredWorkspaceDiff = {
  baseRevision: string
  workRevision: string
  revision: string
  files: StructuredWorkspaceFileDiff[]
}

export type StructuredWorkspaceDiffOptions = {
  contextLines?: number
  maxTextBytes?: number
  maxEntries?: number
}

type ManifestEntry = {
  path: string
  absolutePath: string
  kind: WorkspaceEntryKind
  hash: string
  mode: string
  size: number
  unsafeSymlink: boolean
}

type WorkspaceManifest = {
  revision: string
  entries: Map<string, ManifestEntry>
}

type RawDiffLine = {
  kind: WorkspaceDiffLineKind
  text: string
}

const DEFAULT_CONTEXT_LINES = 3
const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRIES = 20_000
const HASH_BUFFER_BYTES = 64 * 1024

export async function workspaceRevision(root: string, options: Pick<StructuredWorkspaceDiffOptions, "maxEntries"> = {}) {
  return (await readWorkspaceManifest(root, options.maxEntries ?? DEFAULT_MAX_ENTRIES)).revision
}

export async function structuredWorkspaceDiff(
  baselineRoot: string,
  workRoot: string,
  options: StructuredWorkspaceDiffOptions = {},
): Promise<StructuredWorkspaceDiff> {
  const contextLines = nonNegativeInteger(options.contextLines, DEFAULT_CONTEXT_LINES, "contextLines")
  const maxTextBytes = positiveInteger(options.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, "maxTextBytes")
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries")
  const [baseline, work] = await Promise.all([
    readWorkspaceManifest(baselineRoot, maxEntries),
    readWorkspaceManifest(workRoot, maxEntries),
  ])
  const paths = [...new Set([...baseline.entries.keys(), ...work.entries.keys()])].sort()
  const files: StructuredWorkspaceFileDiff[] = []

  for (const path of paths) {
    const before = baseline.entries.get(path)
    const after = work.entries.get(path)
    if (sameEntry(before, after)) continue
    files.push(await fileDiff(path, before, after, { contextLines, maxTextBytes }))
  }

  return {
    baseRevision: baseline.revision,
    workRevision: work.revision,
    revision: hashParts(["workspace-diff-v1", baseline.revision, work.revision]),
    files,
  }
}

async function readWorkspaceManifest(rootPath: string, maxEntries: number): Promise<WorkspaceManifest> {
  const root = await requireDirectoryRoot(rootPath)
  const entries = new Map<string, ManifestEntry>()
  await walkManifest(root, root, entries, maxEntries)
  const revision = hashParts([
    "workspace-revision-v1",
    ...[...entries.values()].map((entry) => [
      entry.path,
      entry.kind,
      entry.mode,
      String(entry.size),
      entry.hash,
      entry.unsafeSymlink ? "unsafe" : "safe",
    ].join("\0")),
  ])
  return { revision, entries }
}

async function requireDirectoryRoot(rootPath: string) {
  const requested = resolve(rootPath)
  let info
  try {
    info = await lstat(requested)
  } catch (cause) {
    throw new PixiuError(`Workspace root is unavailable: ${requested}`, { code: "WORKSPACE_ROOT_UNAVAILABLE", cause })
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PixiuError(`Workspace root must be a real directory: ${requested}`, { code: "WORKSPACE_ROOT_INVALID" })
  }
  return await realpath(requested)
}

async function walkManifest(root: string, current: string, entries: Map<string, ManifestEntry>, maxEntries: number) {
  const children = await readdir(current, { withFileTypes: true })
  children.sort((left, right) => left.name.localeCompare(right.name))
  for (const child of children) {
    const absolutePath = join(current, child.name)
    const path = workspaceRelativePath(root, absolutePath)
    const info = await lstat(absolutePath)
    if (info.isDirectory()) {
      await walkManifest(root, absolutePath, entries, maxEntries)
      continue
    }
    if (entries.size >= maxEntries) {
      throw new PixiuError(`Workspace contains more than ${maxEntries} files.`, { code: "WORKSPACE_TOO_MANY_FILES" })
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(absolutePath)
      entries.set(path, {
        path,
        absolutePath,
        kind: "symlink",
        hash: hashParts(["symlink-v1", target]),
        mode: "120000",
        size: Buffer.byteLength(target),
        unsafeSymlink: await symlinkEscapesRoot(root, absolutePath, target),
      })
      continue
    }
    if (!info.isFile()) {
      throw new PixiuError(`Unsupported workspace entry: ${path}`, { code: "WORKSPACE_ENTRY_UNSUPPORTED" })
    }
    const { hash, size } = await hashFileNoFollow(absolutePath)
    entries.set(path, {
      path,
      absolutePath,
      kind: "file",
      hash,
      mode: info.mode & 0o111 ? "100755" : "100644",
      size,
      unsafeSymlink: false,
    })
  }
}

async function fileDiff(
  path: string,
  before: ManifestEntry | undefined,
  after: ManifestEntry | undefined,
  options: { contextLines: number; maxTextBytes: number },
): Promise<StructuredWorkspaceFileDiff> {
  const status: WorkspaceDiffStatus = !before ? "added" : !after ? "deleted" : before.kind !== after.kind ? "type-changed" : "modified"
  const base = {
    path,
    status,
    ...(before ? { oldKind: before.kind, oldHash: before.hash, oldMode: before.mode, oldSize: before.size } : {}),
    ...(after ? { newKind: after.kind, newHash: after.hash, newMode: after.mode, newSize: after.size } : {}),
    unsafeSymlink: Boolean(before?.unsafeSymlink || after?.unsafeSymlink),
  }
  if (status === "type-changed" || before?.kind === "symlink" || after?.kind === "symlink") {
    return {
      ...base,
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
      hunksUnavailableReason: "type-changed",
    }
  }

  const [oldContent, newContent] = await Promise.all([
    before ? readTextCandidate(before.absolutePath, options.maxTextBytes) : emptyTextCandidate(),
    after ? readTextCandidate(after.absolutePath, options.maxTextBytes) : emptyTextCandidate(),
  ])
  if (oldContent.binary || newContent.binary) {
    return {
      ...base,
      binary: true,
      additions: 0,
      deletions: 0,
      hunks: [],
      hunksUnavailableReason: "binary",
    }
  }
  if (oldContent.tooLarge || newContent.tooLarge) {
    return {
      ...base,
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
      hunksUnavailableReason: "too-large",
    }
  }

  const oldLines = splitTextLines(oldContent.text)
  const newLines = splitTextLines(newContent.text)
  const operations = annotateLines(lineOperations(oldLines.lines, newLines.lines))
  const hunks = buildHunks(path, operations, oldLines, newLines, options.contextLines)
  return {
    ...base,
    binary: false,
    additions: hunks.reduce((total, hunk) => total + hunk.additions, 0),
    deletions: hunks.reduce((total, hunk) => total + hunk.deletions, 0),
    hunks,
    oldHasFinalNewline: oldLines.hasFinalNewline,
    newHasFinalNewline: newLines.hasFinalNewline,
  }
}

function sameEntry(before: ManifestEntry | undefined, after: ManifestEntry | undefined) {
  if (!before || !after) return false
  return before.kind === after.kind && before.hash === after.hash && before.mode === after.mode && before.unsafeSymlink === after.unsafeSymlink
}

async function hashFileNoFollow(path: string) {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag())
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new PixiuError(`Workspace entry changed while reading: ${path}`, { code: "WORKSPACE_ENTRY_CHANGED" })
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
    let position = 0
    while (position < info.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    if (position !== info.size) throw new PixiuError(`Workspace entry changed while reading: ${path}`, { code: "WORKSPACE_ENTRY_CHANGED" })
    return { hash: hash.digest("hex"), size: info.size }
  } finally {
    await handle.close()
  }
}

async function readTextCandidate(path: string, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag())
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new PixiuError(`Workspace entry changed while reading: ${path}`, { code: "WORKSPACE_ENTRY_CHANGED" })
    const length = Math.min(info.size, maxBytes + 1)
    const buffer = Buffer.alloc(length)
    let position = 0
    while (position < length) {
      const { bytesRead } = await handle.read(buffer, position, length - position, position)
      if (!bytesRead) break
      position += bytesRead
    }
    const content = buffer.subarray(0, position)
    return {
      binary: content.includes(0),
      tooLarge: info.size > maxBytes,
      text: content.toString("utf8"),
    }
  } finally {
    await handle.close()
  }
}

function emptyTextCandidate() {
  return { binary: false, tooLarge: false, text: "" }
}

function splitTextLines(text: string) {
  if (!text) return { lines: [] as string[], hasFinalNewline: false }
  const hasFinalNewline = text.endsWith("\n")
  const lines = text.split("\n")
  if (hasFinalNewline) lines.pop()
  return { lines, hasFinalNewline }
}

function lineOperations(before: string[], after: string[]): RawDiffLine[] {
  const max = before.length + after.length
  let frontier = new Map<number, number>([[1, 0]])
  const trace: Map<number, number>[] = []

  for (let distance = 0; distance <= max; distance += 1) {
    const next = new Map<number, number>()
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY
      let x = diagonal === -distance || (diagonal !== distance && right < down) ? down : right + 1
      if (!Number.isFinite(x)) x = 0
      let y = x - diagonal
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1
        y += 1
      }
      next.set(diagonal, x)
      if (x >= before.length && y >= after.length) {
        trace.push(next)
        return backtrackLineOperations(trace, before, after)
      }
    }
    trace.push(next)
    frontier = next
  }
  return []
}

function backtrackLineOperations(trace: Map<number, number>[], before: string[], after: string[]) {
  const operations: RawDiffLine[] = []
  let x = before.length
  let y = after.length

  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const previous = trace[distance - 1]!
    const diagonal = x - y
    const down = previous.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY
    const right = previous.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down) ? diagonal + 1 : diagonal - 1
    const previousX = previous.get(previousDiagonal) ?? 0
    const previousY = previousX - previousDiagonal

    while (x > previousX && y > previousY) {
      operations.push({ kind: "context", text: before[x - 1] ?? "" })
      x -= 1
      y -= 1
    }
    if (x === previousX) {
      operations.push({ kind: "add", text: after[y - 1] ?? "" })
      y -= 1
    } else {
      operations.push({ kind: "delete", text: before[x - 1] ?? "" })
      x -= 1
    }
  }
  while (x > 0 && y > 0) {
    operations.push({ kind: "context", text: before[x - 1] ?? "" })
    x -= 1
    y -= 1
  }
  while (x > 0) {
    operations.push({ kind: "delete", text: before[x - 1] ?? "" })
    x -= 1
  }
  while (y > 0) {
    operations.push({ kind: "add", text: after[y - 1] ?? "" })
    y -= 1
  }
  return operations.reverse()
}

function annotateLines(operations: RawDiffLine[]): WorkspaceDiffLine[] {
  let oldLine = 1
  let newLine = 1
  return operations.map((operation) => {
    const line = { ...operation, oldLine, newLine }
    if (operation.kind !== "add") oldLine += 1
    if (operation.kind !== "delete") newLine += 1
    return line
  })
}

function buildHunks(
  path: string,
  lines: WorkspaceDiffLine[],
  oldText: { lines: string[]; hasFinalNewline: boolean },
  newText: { lines: string[]; hasFinalNewline: boolean },
  contextLines: number,
) {
  const ranges: Array<{ start: number; end: number }> = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.kind === "context") continue
    const start = Math.max(0, index - contextLines)
    const end = Math.min(lines.length - 1, index + contextLines)
    const previous = ranges.at(-1)
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }
  return ranges.map(({ start, end }) => {
    const selected = lines.slice(start, end + 1)
    const oldLines = selected.filter((line) => line.kind !== "add").length
    const newLines = selected.filter((line) => line.kind !== "delete").length
    const first = selected[0]!
    const oldStart = oldLines === 0 ? Math.max(0, first.oldLine - 1) : first.oldLine
    const newStart = newLines === 0 ? Math.max(0, first.newLine - 1) : first.newLine
    const header = `@@ -${formatRange(oldStart, oldLines)} +${formatRange(newStart, newLines)} @@`
    const patchLines = [header]
    for (const line of selected) {
      patchLines.push(`${linePrefix(line.kind)}${line.text}`)
      const missingOldNewline = line.kind !== "add" && line.oldLine === oldText.lines.length && !oldText.hasFinalNewline
      const missingNewNewline = line.kind !== "delete" && line.newLine === newText.lines.length && !newText.hasFinalNewline
      if (missingOldNewline || missingNewNewline) patchLines.push("\\ No newline at end of file")
    }
    const patch = `${patchLines.join("\n")}\n`
    return {
      id: hashParts(["workspace-hunk-v1", path, header, patch]),
      header,
      oldStart,
      oldLines,
      newStart,
      newLines,
      additions: selected.filter((line) => line.kind === "add").length,
      deletions: selected.filter((line) => line.kind === "delete").length,
      lines: selected,
      patch,
    } satisfies WorkspaceDiffHunk
  })
}

function formatRange(start: number, count: number) {
  return count === 1 ? String(start) : `${start},${count}`
}

function linePrefix(kind: WorkspaceDiffLineKind) {
  if (kind === "add") return "+"
  if (kind === "delete") return "-"
  return " "
}

function workspaceRelativePath(root: string, path: string) {
  if (!isInside(root, path)) throw new PixiuError(`Path escapes workspace: ${path}`, { code: "PATH_OUTSIDE_WORKSPACE" })
  const result = relative(root, path)
  if (!result || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new PixiuError(`Invalid workspace path: ${path}`, { code: "WORKSPACE_PATH_INVALID" })
  }
  return result.split(sep).join("/")
}

async function symlinkEscapesRoot(root: string, path: string, target: string) {
  if (isAbsolute(target)) return true
  if (!isInside(root, resolve(dirname(path), target))) return true
  try {
    return !isInside(root, await realpath(path))
  } catch (error: any) {
    if (error?.code === "ENOENT") return false
    return true
  }
}

function noFollowFlag() {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
}

function hashParts(parts: string[]) {
  const hash = createHash("sha256")
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)))
    hash.update(":")
    hash.update(part)
  }
  return hash.digest("hex")
}

function positiveInteger(value: number | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new PixiuError(`${label} must be a positive integer.`, { code: "WORKSPACE_DIFF_INVALID" })
  return value
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) throw new PixiuError(`${label} must be a non-negative integer.`, { code: "WORKSPACE_DIFF_INVALID" })
  return value
}

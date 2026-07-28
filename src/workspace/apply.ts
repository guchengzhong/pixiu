import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { isInside } from "../sandbox/path"
import { PixiuError } from "../shared/errors"
import {
  structuredWorkspaceDiff,
  type StructuredWorkspaceDiff,
  type StructuredWorkspaceFileDiff,
  type WorkspaceDiffHunk,
} from "./diff"
import { loadSessionWorkspaceBinding, type SessionWorkspaceBinding } from "./session"

export const SESSION_WORKSPACE_APPLY_JOURNAL_VERSION = 1

export type SessionWorkspaceChangeSelection = {
  path: string
  hunkIds?: readonly string[]
}

export type SessionWorkspaceChangeRequest = {
  revision: string
  selections: readonly SessionWorkspaceChangeSelection[]
}

export type SessionWorkspaceUndoRequest = {
  revision: string
}

export type SessionWorkspaceChangeOperation = {
  id: string
  action: "apply" | "discard" | "undo"
  revision: string
  selections: SessionWorkspaceChangeSelection[]
  paths: string[]
  createdAt: string
  applyId?: string
}

export type SessionWorkspaceChangeResult = {
  operation: SessionWorkspaceChangeOperation
  revision: string
  canUndo: boolean
}

export type SessionWorkspaceApplyState = {
  operations: SessionWorkspaceChangeOperation[]
  canUndo: boolean
  lastApplyId?: string
}

type EntrySnapshot =
  | { kind: "missing" }
  | {
      kind: "file"
      hash: string
      size: number
      mode: number
      content?: Buffer
      blob?: string
    }

type StoredEntrySnapshot =
  | { kind: "missing" }
  | {
      kind: "file"
      hash: string
      size: number
      mode: number
      blob: string
    }

type StoredChange = {
  path: string
  before: StoredEntrySnapshot
  after: StoredEntrySnapshot
}

type ApplyOperation = SessionWorkspaceChangeOperation & {
  action: "apply"
  changes: StoredChange[]
}

type DiscardOperation = SessionWorkspaceChangeOperation & {
  action: "discard"
}

type UndoOperation = SessionWorkspaceChangeOperation & {
  action: "undo"
  applyId: string
}

type JournalOperation = ApplyOperation | DiscardOperation | UndoOperation

type PendingTransaction = {
  id: string
  action: JournalOperation["action"]
  scope: "project" | "work"
  changes: StoredChange[]
}

type ApplyJournal = {
  version: typeof SESSION_WORKSPACE_APPLY_JOURNAL_VERSION
  operations: JournalOperation[]
  pending?: PendingTransaction
}

type JournalStorage = {
  directory: string
  blobs: string
  journal: string
}

type PreparedSelection = {
  selection: SessionWorkspaceChangeSelection
  file: StructuredWorkspaceFileDiff
  hunks?: WorkspaceDiffHunk[]
}

const JOURNAL_DIRECTORY = ".apply-journal"
const JOURNAL_FILE = "journal.json"
const BLOBS_DIRECTORY = "blobs"
const MAX_JOURNAL_BYTES = 10 * 1024 * 1024
const RESERVED_PATH_COMPONENTS = new Set([".git", ".pixiu", ".tools", ".venv", "node_modules", "pwd"])
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })
const projectLocks = new Map<string, Promise<void>>()

export async function applySessionWorkspaceChanges(
  binding: SessionWorkspaceBinding,
  request: SessionWorkspaceChangeRequest,
): Promise<SessionWorkspaceChangeResult> {
  return withProjectLock(binding.projectRoot, async () => {
    await validateBindingRoots(binding)
    prevalidateRequest(binding, request.selections)
    await assertNoReservedWorkspaceEntries(binding)
    const storage = await journalStorage(binding)
    let journal = await readJournal(storage)
    assertJournalPathsAllowed(binding, journal)
    journal = await recoverPendingTransaction(binding, storage, journal)
    const diff = await currentDiff(binding, request.revision)
    const selections = prepareSelections(binding, diff, request.selections)
    const changes: StoredChange[] = []

    for (const prepared of selections) {
      const baseline = await readDiffSide(binding, "baseline", prepared.file, "old")
      const work = await readDiffSide(binding, "work", prepared.file, "new")
      const project = await readEntry(binding.projectRoot, prepared.selection.path)
      const expected = expectedProjectEntry(journal, prepared.selection.path, baseline)
      if (!sameSnapshot(project, expected.snapshot, expected.exactMode)) {
        throw new PixiuError(`Project file changed since the session baseline: ${prepared.selection.path}`, {
          code: "WORKSPACE_CHANGE_CONFLICT",
        })
      }

      const after = prepared.hunks
        ? materializeAppliedHunks(journal, prepared, baseline, work, diff.revision)
        : work
      const target = sanitizeTargetSnapshot(after)
      if (sameSnapshot(project, target, true)) {
        throw new PixiuError(`Workspace change is already applied: ${prepared.selection.path}`, {
          code: "WORKSPACE_CHANGE_ALREADY_APPLIED",
        })
      }
      changes.push({
        path: prepared.selection.path,
        before: await storeSnapshot(storage, project),
        after: await storeSnapshot(storage, target),
      })
    }

    await assertDiffUnchanged(binding, diff.revision)
    const operation = applyOperation(diff.revision, selections, changes)
    journal = await commitTransaction(binding, storage, journal, {
      id: operation.id,
      action: "apply",
      scope: "project",
      changes,
    }, operation)
    return operationResult(operation, diff.revision, journal)
  })
}

export async function assertSessionWorkspaceSelectionsApplied(
  binding: SessionWorkspaceBinding,
  request: SessionWorkspaceChangeRequest,
): Promise<void> {
  await withProjectLock(binding.projectRoot, async () => {
    await validateBindingRoots(binding)
    prevalidateRequest(binding, request.selections)
    await assertNoReservedWorkspaceEntries(binding)
    const storage = await journalStorage(binding)
    let journal = await readJournal(storage)
    assertJournalPathsAllowed(binding, journal)
    journal = await recoverPendingTransaction(binding, storage, journal)
    const diff = await currentDiff(binding, request.revision)
    const selections = prepareSelections(binding, diff, request.selections)
    const applies = activeApplies(journal)

    for (const prepared of selections) {
      const pathApplies = applies.filter((operation) => operation.paths.includes(prepared.selection.path))
      const baseline = await readDiffSide(binding, "baseline", prepared.file, "old")
      const work = await readDiffSide(binding, "work", prepared.file, "new")
      const expected = expectedProjectEntry(journal, prepared.selection.path, baseline)
      const project = await readEntry(binding.projectRoot, prepared.selection.path)
      if (!sameSnapshot(project, expected.snapshot, expected.exactMode)) {
        throw new PixiuError(`Project file changed after Pixiu applied it: ${prepared.selection.path}`, {
          code: "WORKSPACE_CHANGE_CONFLICT",
        })
      }

      if (!prepared.hunks) {
        if (!pathApplies.length || !sameSnapshot(expected.snapshot, sanitizeTargetSnapshot(work), true)) {
          throw new PixiuError(`Apply the complete session change before staging it: ${prepared.selection.path}`, {
            code: "WORKSPACE_CHANGE_NOT_APPLIED",
          })
        }
        continue
      }

      const explicitlyApplied = new Set(pathApplies.flatMap((operation) => (
        operation.selections.find((selection) => selection.path === prepared.selection.path)?.hunkIds ?? []
      )))
      const wholeFileCurrent = pathApplies.some((operation) => (
        operation.selections.some((selection) => selection.path === prepared.selection.path && selection.hunkIds === undefined)
      )) && sameSnapshot(expected.snapshot, sanitizeTargetSnapshot(work), true)
      const notApplied = prepared.selection.hunkIds?.find((id) => !wholeFileCurrent && !explicitlyApplied.has(id))
      if (notApplied) {
        throw new PixiuError(`Apply the selected session hunk before staging it: ${prepared.selection.path}`, {
          code: "WORKSPACE_CHANGE_NOT_APPLIED",
        })
      }
    }
  })
}

export async function discardSessionWorkspaceChanges(
  binding: SessionWorkspaceBinding,
  request: SessionWorkspaceChangeRequest,
): Promise<SessionWorkspaceChangeResult> {
  return withProjectLock(binding.projectRoot, async () => {
    await validateBindingRoots(binding)
    prevalidateRequest(binding, request.selections)
    await assertNoReservedWorkspaceEntries(binding)
    const storage = await journalStorage(binding)
    let journal = await readJournal(storage)
    assertJournalPathsAllowed(binding, journal)
    journal = await recoverPendingTransaction(binding, storage, journal)
    const diff = await currentDiff(binding, request.revision)
    const selections = prepareSelections(binding, diff, request.selections)
    const changes: StoredChange[] = []

    for (const prepared of selections) {
      const baseline = await readDiffSide(binding, "baseline", prepared.file, "old")
      const work = await readDiffSide(binding, "work", prepared.file, "new")
      const after = prepared.hunks
        ? reverseSelectedHunks(prepared, work, baseline)
        : baseline
      changes.push({
        path: prepared.selection.path,
        before: await storeSnapshot(storage, work),
        after: await storeSnapshot(storage, sanitizeTargetSnapshot(after)),
      })
    }

    await assertDiffUnchanged(binding, diff.revision)
    const operation = simpleOperation("discard", diff.revision, selections)
    journal = await commitTransaction(binding, storage, journal, {
      id: operation.id,
      action: "discard",
      scope: "work",
      changes,
    }, operation)
    const nextRevision = (await structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot)).revision
    return operationResult(operation, nextRevision, journal)
  })
}

export async function undoLastSessionWorkspaceApply(
  binding: SessionWorkspaceBinding,
  request: SessionWorkspaceUndoRequest,
): Promise<SessionWorkspaceChangeResult> {
  return withProjectLock(binding.projectRoot, async () => {
    await validateBindingRoots(binding)
    await assertNoReservedWorkspaceEntries(binding)
    const storage = await journalStorage(binding)
    let journal = await readJournal(storage)
    assertJournalPathsAllowed(binding, journal)
    journal = await recoverPendingTransaction(binding, storage, journal)
    const diff = await currentDiff(binding, request.revision)
    const apply = lastActiveApply(journal)
    if (!apply) throw new PixiuError("There is no applied workspace change to undo.", { code: "WORKSPACE_UNDO_EMPTY" })

    const changes = apply.changes.map((change) => ({
      path: change.path,
      before: change.after,
      after: change.before,
    }))
    await preflightStoredChanges(binding.projectRoot, changes, "WORKSPACE_UNDO_CONFLICT")
    const operation: UndoOperation = {
      ...simpleOperation("undo", diff.revision, apply.selections),
      applyId: apply.id,
    }
    journal = await commitTransaction(binding, storage, journal, {
      id: operation.id,
      action: "undo",
      scope: "project",
      changes,
    }, operation, "WORKSPACE_UNDO_CONFLICT")
    return operationResult(operation, diff.revision, journal)
  })
}

export async function readSessionWorkspaceApplyState(
  binding: SessionWorkspaceBinding,
): Promise<SessionWorkspaceApplyState> {
  return withProjectLock(binding.projectRoot, async () => {
    await validateBindingRoots(binding)
    await assertNoReservedWorkspaceEntries(binding)
    const storage = await journalStorage(binding)
    let journal = await readJournal(storage)
    assertJournalPathsAllowed(binding, journal)
    journal = await recoverPendingTransaction(binding, storage, journal)
    const lastApply = lastActiveApply(journal)
    return {
      operations: journal.operations.map(publicOperation),
      canUndo: Boolean(lastApply),
      ...(lastApply ? { lastApplyId: lastApply.id } : {}),
    }
  })
}

async function currentDiff(binding: SessionWorkspaceBinding, expectedRevision: string) {
  const revision = normalizeRevision(expectedRevision)
  const diff = await structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot)
  if (diff.baseRevision !== binding.baseRevision) {
    throw new PixiuError("The session workspace baseline changed.", { code: "SESSION_WORKSPACE_BASELINE_CHANGED" })
  }
  if (diff.revision !== revision) {
    throw new PixiuError("The workspace changes changed since they were reviewed.", { code: "WORKSPACE_CHANGE_STALE" })
  }
  return diff
}

async function assertDiffUnchanged(binding: SessionWorkspaceBinding, revision: string) {
  const current = await structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot)
  if (current.revision !== revision) {
    throw new PixiuError("The workspace changes changed while the operation was prepared.", { code: "WORKSPACE_CHANGE_STALE" })
  }
}

function prepareSelections(
  binding: SessionWorkspaceBinding,
  diff: StructuredWorkspaceDiff,
  input: readonly SessionWorkspaceChangeSelection[],
): PreparedSelection[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new PixiuError("At least one workspace change must be selected.", { code: "WORKSPACE_CHANGE_SELECTION_INVALID" })
  }
  const byPath = new Map(diff.files.map((file) => [file.path, file]))
  const seenPaths = new Set<string>()
  const selections = input.map((item) => normalizeSelection(item))
  selections.sort((left, right) => left.path.localeCompare(right.path))

  return selections.map((selection) => {
    if (seenPaths.has(selection.path)) {
      throw new PixiuError(`Workspace path was selected more than once: ${selection.path}`, {
        code: "WORKSPACE_CHANGE_SELECTION_INVALID",
      })
    }
    seenPaths.add(selection.path)
    assertPathAllowed(binding, selection.path)
    const file = byPath.get(selection.path)
    if (!file) {
      throw new PixiuError(`Unknown workspace change: ${selection.path}`, { code: "WORKSPACE_CHANGE_NOT_FOUND" })
    }
    if (diff.files.some((candidate) => candidate.path !== file.path && (
      candidate.path.startsWith(`${file.path}/`) || file.path.startsWith(`${candidate.path}/`)
    ))) {
      throw new PixiuError(`File-to-directory workspace changes are not supported: ${selection.path}`, {
        code: "WORKSPACE_CHANGE_UNSUPPORTED",
      })
    }
    if (file.unsafeSymlink || file.oldKind === "symlink" || file.newKind === "symlink" || file.status === "type-changed") {
      throw new PixiuError(`Symbolic-link workspace changes are not supported: ${selection.path}`, {
        code: "WORKSPACE_CHANGE_UNSUPPORTED",
      })
    }
    if (!selection.hunkIds) return { selection, file }
    if (
      file.status !== "modified" ||
      file.oldKind !== "file" ||
      file.newKind !== "file" ||
      file.binary ||
      file.hunksUnavailableReason ||
      file.oldHasFinalNewline !== file.newHasFinalNewline
    ) {
      throw new PixiuError(`Hunk operations are unavailable for ${selection.path}.`, { code: "WORKSPACE_HUNKS_UNAVAILABLE" })
    }
    const byId = new Map(file.hunks.map((hunk) => [hunk.id, hunk]))
    const hunks = selection.hunkIds.map((id) => {
      const hunk = byId.get(id)
      if (!hunk) throw new PixiuError(`Unknown workspace hunk for ${selection.path}: ${id}`, { code: "WORKSPACE_HUNK_NOT_FOUND" })
      return hunk
    })
    return { selection, file, hunks }
  })
}

function prevalidateRequest(binding: SessionWorkspaceBinding, selections: readonly SessionWorkspaceChangeSelection[]) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new PixiuError("At least one workspace change must be selected.", { code: "WORKSPACE_CHANGE_SELECTION_INVALID" })
  }
  for (const selection of selections) assertPathAllowed(binding, normalizeSelection(selection).path)
}

function assertJournalPathsAllowed(binding: SessionWorkspaceBinding, journal: ApplyJournal) {
  for (const operation of journal.operations) {
    for (const selection of operation.selections) assertPathAllowed(binding, selection.path)
    if (operation.action === "apply") {
      for (const change of operation.changes) assertPathAllowed(binding, change.path)
    }
  }
  for (const change of journal.pending?.changes ?? []) assertPathAllowed(binding, change.path)
}

async function assertNoReservedWorkspaceEntries(binding: SessionWorkspaceBinding) {
  await walkForReservedEntries(binding, binding.baselineRoot, binding.baselineRoot)
  await walkForReservedEntries(binding, binding.workRoot, binding.workRoot)
}

async function walkForReservedEntries(binding: SessionWorkspaceBinding, root: string, directory: string): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true })
  for (const child of children) {
    const absolutePath = join(directory, child.name)
    const path = relative(root, absolutePath).split(sep).join("/")
    assertPathAllowed(binding, path)
    if ((await lstat(absolutePath)).isDirectory()) await walkForReservedEntries(binding, root, absolutePath)
  }
}

function normalizeSelection(value: SessionWorkspaceChangeSelection): SessionWorkspaceChangeSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PixiuError("Workspace selections must be objects.", { code: "WORKSPACE_CHANGE_SELECTION_INVALID" })
  }
  const path = normalizeRelativePath(value.path)
  if (value.hunkIds === undefined) return { path }
  if (!Array.isArray(value.hunkIds) || value.hunkIds.length === 0) {
    throw new PixiuError("hunkIds must contain at least one hunk id.", { code: "WORKSPACE_CHANGE_SELECTION_INVALID" })
  }
  const hunkIds = value.hunkIds.map((id) => {
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) {
      throw new PixiuError("hunkIds contains an invalid hunk id.", { code: "WORKSPACE_CHANGE_SELECTION_INVALID" })
    }
    return id
  })
  if (new Set(hunkIds).size !== hunkIds.length) {
    throw new PixiuError("hunkIds contains duplicates.", { code: "WORKSPACE_CHANGE_SELECTION_INVALID" })
  }
  return { path, hunkIds }
}

function assertPathAllowed(binding: SessionWorkspaceBinding, path: string) {
  const parts = path.split("/")
  if (parts.some((part) => RESERVED_PATH_COMPONENTS.has(part))) {
    throw new PixiuError(`Workspace change path is reserved: ${path}`, { code: "WORKSPACE_CHANGE_PATH_RESERVED" })
  }
  if (binding.excludedPaths.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) {
    throw new PixiuError(`Workspace change path is excluded: ${path}`, { code: "WORKSPACE_CHANGE_PATH_RESERVED" })
  }
}

async function readDiffSide(
  binding: SessionWorkspaceBinding,
  scope: "baseline" | "work",
  file: StructuredWorkspaceFileDiff,
  side: "old" | "new",
) {
  const expectedKind = side === "old" ? file.oldKind : file.newKind
  const expectedHash = side === "old" ? file.oldHash : file.newHash
  const snapshot = await readEntry(scope === "baseline" ? binding.baselineRoot : binding.workRoot, file.path)
  if (!expectedKind) {
    if (snapshot.kind !== "missing") throw new PixiuError(`Workspace entry changed while reading: ${file.path}`, { code: "WORKSPACE_CHANGE_STALE" })
    return snapshot
  }
  if (expectedKind !== "file" || snapshot.kind !== "file" || snapshot.hash !== expectedHash) {
    throw new PixiuError(`Workspace entry changed while reading: ${file.path}`, { code: "WORKSPACE_CHANGE_STALE" })
  }
  return snapshot
}

function materializeAppliedHunks(
  journal: ApplyJournal,
  prepared: PreparedSelection,
  baseline: EntrySnapshot,
  work: EntrySnapshot,
  revision: string,
) {
  if (baseline.kind !== "file" || work.kind !== "file" || !prepared.hunks) {
    throw new PixiuError(`Hunk operations are unavailable for ${prepared.selection.path}.`, { code: "WORKSPACE_HUNKS_UNAVAILABLE" })
  }
  const active = activeApplies(journal).filter((operation) => operation.paths.includes(prepared.selection.path))
  const selected = new Set<string>(prepared.selection.hunkIds)
  const alreadyApplied = new Set<string>()
  for (const operation of active) {
    const previous = operation.selections.find((selection) => selection.path === prepared.selection.path)
    if (!previous) continue
    if (operation.revision !== revision || !previous.hunkIds) {
      throw new PixiuError(`Previously applied changes for ${prepared.selection.path} require a whole-file refresh.`, {
        code: "WORKSPACE_CHANGE_REBASE_REQUIRED",
      })
    }
    for (const id of previous.hunkIds) {
      alreadyApplied.add(id)
      selected.add(id)
    }
  }
  if (prepared.selection.hunkIds?.some((id) => alreadyApplied.has(id))) {
    throw new PixiuError(`Workspace hunk is already applied for ${prepared.selection.path}.`, {
      code: "WORKSPACE_CHANGE_ALREADY_APPLIED",
    })
  }
  const byId = new Map(prepared.file.hunks.map((hunk) => [hunk.id, hunk]))
  const hunks = [...selected].map((id) => {
    const hunk = byId.get(id)
    if (!hunk) throw new PixiuError(`Previously applied hunk is no longer available: ${id}`, { code: "WORKSPACE_CHANGE_REBASE_REQUIRED" })
    return hunk
  })
  return patchSnapshot(baseline, work, hunks, "forward")
}

function reverseSelectedHunks(prepared: PreparedSelection, work: EntrySnapshot, baseline: EntrySnapshot) {
  if (baseline.kind !== "file" || work.kind !== "file" || !prepared.hunks) {
    throw new PixiuError(`Hunk operations are unavailable for ${prepared.selection.path}.`, { code: "WORKSPACE_HUNKS_UNAVAILABLE" })
  }
  return patchSnapshot(work, baseline, prepared.hunks, "reverse")
}

function patchSnapshot(
  source: Extract<EntrySnapshot, { kind: "file" }>,
  target: Extract<EntrySnapshot, { kind: "file" }>,
  hunks: WorkspaceDiffHunk[],
  direction: "forward" | "reverse",
): EntrySnapshot {
  const sourceText = decodeUtf8(source.content ?? Buffer.alloc(0))
  decodeUtf8(target.content ?? Buffer.alloc(0))
  const parsed = splitText(sourceText)
  const ordered = [...hunks].sort((left, right) => {
    const leftStart = direction === "forward" ? left.oldStart : left.newStart
    const rightStart = direction === "forward" ? right.oldStart : right.newStart
    return rightStart - leftStart
  })
  for (const hunk of ordered) {
    const before = hunk.lines.filter((line) => direction === "forward" ? line.kind !== "add" : line.kind !== "delete").map((line) => line.text)
    const after = hunk.lines.filter((line) => direction === "forward" ? line.kind !== "delete" : line.kind !== "add").map((line) => line.text)
    const start = (direction === "forward" ? hunk.oldStart : hunk.newStart) - 1
    if (start < 0 || !matchesLines(parsed.lines, start, before)) {
      throw new PixiuError("Workspace hunk no longer matches its source.", { code: "WORKSPACE_CHANGE_STALE" })
    }
    parsed.lines.splice(start, before.length, ...after)
  }
  const content = Buffer.from(`${parsed.lines.join("\n")}${parsed.hasFinalNewline ? "\n" : ""}`, "utf8")
  return fileSnapshot(content, source.mode)
}

function matchesLines(lines: string[], start: number, expected: string[]) {
  if (start + expected.length > lines.length) return false
  return expected.every((line, index) => lines[start + index] === line)
}

function decodeUtf8(content: Buffer) {
  try {
    return UTF8_DECODER.decode(content)
  } catch (cause) {
    throw new PixiuError("Workspace hunks require valid UTF-8 text.", { code: "WORKSPACE_HUNKS_UNAVAILABLE", cause })
  }
}

function splitText(text: string) {
  if (!text) return { lines: [] as string[], hasFinalNewline: false }
  const hasFinalNewline = text.endsWith("\n")
  const lines = text.split("\n")
  if (hasFinalNewline) lines.pop()
  return { lines, hasFinalNewline }
}

function sanitizeTargetSnapshot(snapshot: EntrySnapshot): EntrySnapshot {
  if (snapshot.kind === "missing") return snapshot
  return fileSnapshot(snapshot.content ?? Buffer.alloc(0), snapshot.mode & 0o111 ? 0o755 : 0o644)
}

function expectedProjectEntry(journal: ApplyJournal, path: string, baseline: EntrySnapshot) {
  const operations = activeApplies(journal)
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const change = operations[index]!.changes.find((candidate) => candidate.path === path)
    if (change) return { snapshot: change.after, exactMode: true }
  }
  return { snapshot: baseline, exactMode: false }
}

function activeApplies(journal: ApplyJournal) {
  const undone = new Set(journal.operations.filter((operation): operation is UndoOperation => operation.action === "undo").map((operation) => operation.applyId))
  return journal.operations.filter((operation): operation is ApplyOperation => operation.action === "apply" && !undone.has(operation.id))
}

function lastActiveApply(journal: ApplyJournal) {
  return activeApplies(journal).at(-1)
}

function applyOperation(revision: string, selections: PreparedSelection[], changes: StoredChange[]): ApplyOperation {
  return {
    ...simpleOperation("apply", revision, selections),
    action: "apply",
    changes,
  }
}

function simpleOperation<Action extends SessionWorkspaceChangeOperation["action"]>(
  action: Action,
  revision: string,
  selections: PreparedSelection[] | SessionWorkspaceChangeSelection[],
): SessionWorkspaceChangeOperation & { action: Action } {
  const normalized = selections.map((item) => "selection" in item ? item.selection : item)
  return {
    id: `wsop_${randomUUID().replaceAll("-", "")}`,
    action,
    revision,
    selections: normalized.map(copySelection),
    paths: normalized.map((selection) => selection.path),
    createdAt: new Date().toISOString(),
  }
}

function operationResult(operation: JournalOperation, revision: string, journal: ApplyJournal): SessionWorkspaceChangeResult {
  return {
    operation: publicOperation(operation),
    revision,
    canUndo: Boolean(lastActiveApply(journal)),
  }
}

function publicOperation(operation: JournalOperation): SessionWorkspaceChangeOperation {
  return {
    id: operation.id,
    action: operation.action,
    revision: operation.revision,
    selections: operation.selections.map(copySelection),
    paths: [...operation.paths],
    createdAt: operation.createdAt,
    ...(operation.action === "undo" ? { applyId: operation.applyId } : {}),
  }
}

function copySelection(selection: SessionWorkspaceChangeSelection): SessionWorkspaceChangeSelection {
  return selection.hunkIds ? { path: selection.path, hunkIds: [...selection.hunkIds] } : { path: selection.path }
}

async function commitTransaction(
  binding: SessionWorkspaceBinding,
  storage: JournalStorage,
  journal: ApplyJournal,
  pending: PendingTransaction,
  operation: JournalOperation,
  conflictCode = "WORKSPACE_CHANGE_CONFLICT",
) {
  await preflightStoredChanges(pending.scope === "project" ? binding.projectRoot : binding.workRoot, pending.changes, conflictCode)
  const prepared: ApplyJournal = { ...journal, pending }
  await writeJournal(storage, prepared)
  try {
    await executeStoredChanges(pending.scope === "project" ? binding.projectRoot : binding.workRoot, storage, pending.changes, conflictCode)
  } catch (cause) {
    try {
      await recoverPendingTransaction(binding, storage, prepared)
    } catch (rollbackCause) {
      throw new PixiuError("Workspace change failed and could not be rolled back automatically.", {
        code: "WORKSPACE_CHANGE_ROLLBACK_FAILED",
        cause: new AggregateError([cause, rollbackCause]),
      })
    }
    throw cause
  }
  const committed: ApplyJournal = {
    version: SESSION_WORKSPACE_APPLY_JOURNAL_VERSION,
    operations: [...journal.operations, operation],
  }
  try {
    await writeJournal(storage, committed)
    return committed
  } catch (cause) {
    try {
      await recoverPendingTransaction(binding, storage, prepared)
    } catch (rollbackCause) {
      throw new PixiuError("The workspace change was written but its journal could not be committed or rolled back.", {
        code: "WORKSPACE_CHANGE_ROLLBACK_FAILED",
        cause: new AggregateError([cause, rollbackCause]),
      })
    }
    throw new PixiuError("Failed to commit the workspace change journal.", { code: "WORKSPACE_JOURNAL_WRITE_FAILED", cause })
  }
}

async function recoverPendingTransaction(binding: SessionWorkspaceBinding, storage: JournalStorage, journal: ApplyJournal) {
  if (!journal.pending) return journal
  const root = journal.pending.scope === "project" ? binding.projectRoot : binding.workRoot
  for (const change of journal.pending.changes) {
    const current = await readEntry(root, change.path)
    if (!sameSnapshot(current, change.before, true) && !sameSnapshot(current, change.after, true)) {
      throw new PixiuError(`Cannot recover interrupted workspace change for ${change.path}.`, {
        code: "WORKSPACE_JOURNAL_RECOVERY_CONFLICT",
      })
    }
  }
  await restoreStoredChanges(root, storage, journal.pending.changes)
  const recovered: ApplyJournal = {
    version: SESSION_WORKSPACE_APPLY_JOURNAL_VERSION,
    operations: journal.operations,
  }
  await writeJournal(storage, recovered)
  return recovered
}

async function executeStoredChanges(root: string, storage: JournalStorage, changes: StoredChange[], conflictCode: string) {
  await preflightStoredChanges(root, changes, conflictCode)
  for (const change of changes) {
    const current = await readEntry(root, change.path)
    if (!sameSnapshot(current, change.before, true)) {
      throw new PixiuError(`Workspace target changed while applying: ${change.path}`, { code: conflictCode })
    }
    await writeStoredEntry(root, change.path, change.after, storage, change.before)
  }
  for (const change of changes) {
    if (!sameSnapshot(await readEntry(root, change.path), change.after, true)) {
      throw new PixiuError(`Workspace target could not be verified: ${change.path}`, { code: "WORKSPACE_CHANGE_VERIFY_FAILED" })
    }
  }
}

async function preflightStoredChanges(root: string, changes: StoredChange[], conflictCode: string) {
  for (const change of changes) {
    if (!sameSnapshot(await readEntry(root, change.path), change.before, true)) {
      throw new PixiuError(`Workspace target changed before applying: ${change.path}`, { code: conflictCode })
    }
  }
}

async function restoreStoredChanges(root: string, storage: JournalStorage, changes: StoredChange[]) {
  for (const change of [...changes].reverse()) {
    const current = await readEntry(root, change.path)
    if (sameSnapshot(current, change.before, true)) continue
    if (!sameSnapshot(current, change.after, true)) {
      throw new PixiuError(`Cannot recover interrupted workspace change for ${change.path}.`, {
        code: "WORKSPACE_JOURNAL_RECOVERY_CONFLICT",
      })
    }
    await writeStoredEntry(root, change.path, change.before, storage, change.after)
  }
}

async function writeStoredEntry(
  root: string,
  path: string,
  snapshot: StoredEntrySnapshot,
  storage: JournalStorage,
  expected: StoredEntrySnapshot,
) {
  const target = await resolveSafeTarget(root, path, true)
  if (snapshot.kind === "missing") {
    try {
      const info = await lstat(target)
      if (info.isSymbolicLink()) throw symlinkError(path)
      if (!info.isFile()) throw invalidTarget(path)
      await unlink(target)
    } catch (error: any) {
      if (error instanceof PixiuError) throw error
      if (error?.code !== "ENOENT") throw error
    }
    return
  }

  await ensureSafeParents(root, path)
  const content = await readBlob(storage, snapshot)
  const parent = dirname(target)
  const temporary = join(parent, `.${basename(target)}.pixiu-${randomUUID()}`)
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), snapshot.mode)
    await handle.writeFile(content)
    await handle.chmod(snapshot.mode)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      const current = await lstat(target)
      if (current.isSymbolicLink()) throw symlinkError(path)
      if (!current.isFile()) throw invalidTarget(path)
    } catch (error: any) {
      if (error instanceof PixiuError) throw error
      if (error?.code !== "ENOENT") throw error
    }
    if (expected.kind === "missing") {
      try {
        await link(temporary, target)
      } catch (cause: any) {
        if (cause?.code === "EEXIST") {
          throw new PixiuError(`Workspace target appeared while applying: ${path}`, { code: "WORKSPACE_CHANGE_CONFLICT", cause })
        }
        throw cause
      }
      await unlink(temporary)
    } else {
      await rename(temporary, target)
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function readEntry(root: string, path: string): Promise<EntrySnapshot> {
  const target = await resolveSafeTarget(root, path, true)
  let info
  try {
    info = await lstat(target)
  } catch (error: any) {
    if (error?.code === "ENOENT") return { kind: "missing" }
    throw error
  }
  if (info.isSymbolicLink()) throw symlinkError(path)
  if (!info.isFile()) throw invalidTarget(path)
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | noFollowFlag())
    const before = await handle.stat()
    if (!before.isFile()) throw invalidTarget(path)
    const content = await handle.readFile()
    const after = await handle.stat()
    if (before.size !== content.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new PixiuError(`Workspace entry changed while reading: ${path}`, { code: "WORKSPACE_ENTRY_CHANGED" })
    }
    return fileSnapshot(content, before.mode & 0o777)
  } catch (error: any) {
    if (error instanceof PixiuError) throw error
    if (error?.code === "ELOOP") throw symlinkError(path)
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function fileSnapshot(content: Buffer, mode: number): Extract<EntrySnapshot, { kind: "file" }> {
  return {
    kind: "file",
    hash: createHash("sha256").update(content).digest("hex"),
    size: content.length,
    mode: mode & 0o777,
    content,
  }
}

function sameSnapshot(left: EntrySnapshot, right: EntrySnapshot | StoredEntrySnapshot, exactMode: boolean) {
  if (left.kind !== right.kind) return false
  if (left.kind === "missing" || right.kind === "missing") return true
  const sameMode = exactMode ? left.mode === right.mode : Boolean(left.mode & 0o111) === Boolean(right.mode & 0o111)
  return sameMode && left.hash === right.hash && left.size === right.size
}

async function storeSnapshot(storage: JournalStorage, snapshot: EntrySnapshot): Promise<StoredEntrySnapshot> {
  if (snapshot.kind === "missing") return snapshot
  const blob = snapshot.hash
  await ensureBlob(storage, snapshot)
  return { kind: "file", hash: snapshot.hash, size: snapshot.size, mode: snapshot.mode, blob }
}

async function ensureBlob(storage: JournalStorage, snapshot: Extract<EntrySnapshot, { kind: "file" }>) {
  const target = join(storage.blobs, snapshot.hash)
  try {
    const existing = await readStoredFile(target, snapshot.size)
    if (createHash("sha256").update(existing).digest("hex") !== snapshot.hash) throw invalidJournal()
    return
  } catch (error: any) {
    if (error instanceof PixiuError) throw error
    if (error?.code !== "ENOENT") throw error
  }
  const temporary = join(storage.blobs, `.${snapshot.hash}.${randomUUID()}`)
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
    await handle.writeFile(snapshot.content ?? Buffer.alloc(0))
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, target)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function readBlob(storage: JournalStorage, snapshot: Extract<StoredEntrySnapshot, { kind: "file" }>) {
  const content = await readStoredFile(join(storage.blobs, snapshot.blob), snapshot.size)
  if (createHash("sha256").update(content).digest("hex") !== snapshot.hash) throw invalidJournal()
  return content
}

async function readStoredFile(path: string, expectedSize: number) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag())
    const info = await handle.stat()
    if (!info.isFile() || info.size !== expectedSize) throw invalidJournal()
    return await handle.readFile()
  } catch (error: any) {
    if (error instanceof PixiuError) throw error
    if (error?.code === "ELOOP") throw invalidJournal()
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function journalStorage(binding: SessionWorkspaceBinding): Promise<JournalStorage> {
  const directory = join(binding.root, JOURNAL_DIRECTORY)
  await ensurePlainDirectory(binding.root, directory)
  const blobs = join(directory, BLOBS_DIRECTORY)
  await ensurePlainDirectory(binding.root, blobs)
  return { directory, blobs, journal: join(directory, JOURNAL_FILE) }
}

async function ensurePlainDirectory(rootPath: string, path: string) {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error
  }
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalidJournal()
  if (!isInside(await realpath(rootPath), await realpath(path))) throw invalidJournal()
}

async function readJournal(storage: JournalStorage): Promise<ApplyJournal> {
  let handle
  try {
    handle = await open(storage.journal, constants.O_RDONLY | noFollowFlag())
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) throw invalidJournal()
    return normalizeJournal(JSON.parse((await handle.readFile()).toString("utf8")))
  } catch (error: any) {
    if (error instanceof PixiuError) throw error
    if (error?.code === "ENOENT") return { version: SESSION_WORKSPACE_APPLY_JOURNAL_VERSION, operations: [] }
    throw invalidJournal(error)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeJournal(storage: JournalStorage, journal: ApplyJournal) {
  const temporary = join(storage.directory, `.${JOURNAL_FILE}.${randomUUID()}`)
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
    await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      const current = await lstat(storage.journal)
      if (current.isSymbolicLink() || !current.isFile()) throw invalidJournal()
    } catch (error: any) {
      if (error instanceof PixiuError) throw error
      if (error?.code !== "ENOENT") throw error
    }
    await rename(temporary, storage.journal)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function normalizeJournal(value: unknown): ApplyJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidJournal()
  const input = value as Record<string, unknown>
  if (input.version !== SESSION_WORKSPACE_APPLY_JOURNAL_VERSION || !Array.isArray(input.operations)) throw invalidJournal()
  const operations = input.operations.map(normalizeJournalOperation)
  validateOperationHistory(operations)
  const pending = input.pending === undefined ? undefined : normalizePending(input.pending)
  return {
    version: SESSION_WORKSPACE_APPLY_JOURNAL_VERSION,
    operations,
    ...(pending ? { pending } : {}),
  }
}

function normalizeJournalOperation(value: unknown): JournalOperation {
  const input = objectValue(value)
  const base = normalizePublicOperation(input)
  if (base.action === "apply") {
    if (!Array.isArray(input.changes)) throw invalidJournal()
    const changes = input.changes.map(normalizeStoredChange)
    if (changes.map((change) => change.path).join("\0") !== base.paths.join("\0")) throw invalidJournal()
    return { ...base, action: "apply", changes }
  }
  if (base.action === "discard") return { ...base, action: "discard" }
  const applyId = stringValue(input.applyId)
  if (!applyId) throw invalidJournal()
  return { ...base, action: "undo", applyId }
}

function normalizePublicOperation(input: Record<string, unknown>): SessionWorkspaceChangeOperation {
  const id = stringValue(input.id)
  const action = input.action === "apply" || input.action === "discard" || input.action === "undo" ? input.action : undefined
  const revision = stringValue(input.revision)
  const createdAt = stringValue(input.createdAt)
  if (!id || !/^wsop_[0-9a-f]{32}$/.test(id) || !action || !revision || !createdAt || !Array.isArray(input.selections) || !Array.isArray(input.paths)) {
    throw invalidJournal()
  }
  const selections = input.selections.map((selection) => normalizeSelection(selection as SessionWorkspaceChangeSelection))
  const paths = input.paths.map((path) => typeof path === "string" ? normalizeRelativePath(path) : invalidJournalThrow())
  if (paths.join("\0") !== selections.map((selection) => selection.path).join("\0")) throw invalidJournal()
  return { id, action, revision: normalizeRevision(revision), selections, paths, createdAt }
}

function normalizePending(value: unknown): PendingTransaction {
  const input = objectValue(value)
  const id = stringValue(input.id)
  const action = input.action === "apply" || input.action === "discard" || input.action === "undo" ? input.action : undefined
  const scope = input.scope === "project" || input.scope === "work" ? input.scope : undefined
  if (!id || !action || !scope || !Array.isArray(input.changes)) throw invalidJournal()
  return { id, action, scope, changes: input.changes.map(normalizeStoredChange) }
}

function normalizeStoredChange(value: unknown): StoredChange {
  const input = objectValue(value)
  const path = typeof input.path === "string" ? normalizeRelativePath(input.path) : invalidJournalThrow()
  return { path, before: normalizeStoredSnapshot(input.before), after: normalizeStoredSnapshot(input.after) }
}

function normalizeStoredSnapshot(value: unknown): StoredEntrySnapshot {
  const input = objectValue(value)
  if (input.kind === "missing") return { kind: "missing" }
  if (input.kind !== "file") throw invalidJournal()
  const hash = stringValue(input.hash)
  const blob = stringValue(input.blob)
  const size = input.size
  const mode = input.mode
  if (!hash || !/^[0-9a-f]{64}$/.test(hash) || blob !== hash || !Number.isSafeInteger(size) || Number(size) < 0 || !Number.isInteger(mode) || Number(mode) < 0 || Number(mode) > 0o777) {
    throw invalidJournal()
  }
  return { kind: "file", hash, blob, size: Number(size), mode: Number(mode) }
}

function validateOperationHistory(operations: JournalOperation[]) {
  const ids = new Set<string>()
  const applies = new Set<string>()
  const undone = new Set<string>()
  const active: string[] = []
  for (const operation of operations) {
    if (ids.has(operation.id)) throw invalidJournal()
    ids.add(operation.id)
    if (operation.action === "apply") {
      applies.add(operation.id)
      active.push(operation.id)
      continue
    }
    if (operation.action === "undo") {
      if (!applies.has(operation.applyId) || undone.has(operation.applyId) || active.at(-1) !== operation.applyId) throw invalidJournal()
      undone.add(operation.applyId)
      active.pop()
    }
  }
}

async function validateBindingRoots(binding: SessionWorkspaceBinding) {
  const loaded = await loadSessionWorkspaceBinding({
    stateRoot: binding.stateRoot,
    projectRoot: binding.projectRoot,
    sessionId: binding.sessionId,
  })
  if (
    loaded.root !== binding.root ||
    loaded.baselineRoot !== binding.baselineRoot ||
    loaded.workRoot !== binding.workRoot ||
    loaded.baseRevision !== binding.baseRevision
  ) {
    throw new PixiuError("Session workspace binding metadata does not match the requested binding.", {
      code: "SESSION_WORKSPACE_META_MISMATCH",
    })
  }
  const bindingRoot = await canonicalDirectory(binding.root, "SESSION_WORKSPACE_INVALID")
  const baseline = await canonicalDirectory(binding.baselineRoot, "SESSION_WORKSPACE_INVALID")
  const work = await canonicalDirectory(binding.workRoot, "SESSION_WORKSPACE_INVALID")
  const project = await canonicalDirectory(binding.projectRoot, "PROJECT_ROOT_INVALID")
  if (bindingRoot !== resolve(binding.root) || baseline !== resolve(binding.baselineRoot) || work !== resolve(binding.workRoot) || project !== resolve(binding.projectRoot)) {
    throw new PixiuError("Session workspace binding contains a symbolic-link root.", { code: "SESSION_WORKSPACE_INVALID" })
  }
  if (!isInside(bindingRoot, baseline) || !isInside(bindingRoot, work)) {
    throw new PixiuError("Session workspace roots escape the binding.", { code: "SESSION_WORKSPACE_INVALID" })
  }
}

async function canonicalDirectory(path: string, code: string) {
  let info
  try {
    info = await lstat(path)
  } catch (cause) {
    throw new PixiuError(`Directory is unavailable: ${path}`, { code, cause })
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PixiuError(`Expected a real directory: ${path}`, { code })
  return await realpath(path)
}

async function resolveSafeTarget(rootPath: string, inputPath: string, allowMissing: boolean) {
  const root = await canonicalDirectory(rootPath, "WORKSPACE_ROOT_INVALID")
  const path = normalizeRelativePath(inputPath)
  const target = resolve(root, path)
  if (!isInside(root, target)) throw new PixiuError(`Path escapes workspace: ${path}`, { code: "PATH_OUTSIDE_WORKSPACE" })
  const parts = relative(root, target).split(sep).filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw symlinkError(path)
      if (index < parts.length - 1 && !info.isDirectory()) throw invalidTarget(path)
    } catch (error: any) {
      if (error instanceof PixiuError) throw error
      if (error?.code === "ENOENT" && allowMissing) return target
      if (error?.code === "ENOENT") throw new PixiuError(`Unknown workspace path: ${path}`, { code: "WORKSPACE_PATH_NOT_FOUND", cause: error })
      throw error
    }
  }
  return target
}

async function ensureSafeParents(rootPath: string, path: string) {
  const root = await canonicalDirectory(rootPath, "WORKSPACE_ROOT_INVALID")
  const parts = normalizeRelativePath(path).split("/").slice(0, -1)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error
    }
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw symlinkError(path)
    if (!info.isDirectory()) throw invalidTarget(path)
    if (!isInside(root, await realpath(current))) throw new PixiuError(`Path escapes workspace: ${path}`, { code: "PATH_OUTSIDE_WORKSPACE" })
  }
}

function normalizeRelativePath(value: string) {
  if (typeof value !== "string") throw new PixiuError("Workspace path must be a string.", { code: "WORKSPACE_PATH_INVALID" })
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  const parts = path.split("/").filter((part) => part && part !== ".")
  if (!path || path.includes("\0") || !parts.length || isAbsolute(path) || /^[A-Za-z]:\//.test(path) || parts.some((part) => part === "..")) {
    throw new PixiuError(`Invalid workspace path: ${value}`, { code: "WORKSPACE_PATH_INVALID" })
  }
  return parts.join("/")
}

function normalizeRevision(value: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PixiuError("Workspace revision is invalid.", { code: "WORKSPACE_CHANGE_REVISION_INVALID" })
  }
  return value
}

async function withProjectLock<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(projectRoot)
  const previous = projectLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => { release = resolveGate })
  const current = previous.catch(() => undefined).then(() => gate)
  projectLocks.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (projectLocks.get(key) === current) projectLocks.delete(key)
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidJournal()
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function invalidJournal(cause?: unknown) {
  return new PixiuError("Session workspace apply journal is invalid.", { code: "WORKSPACE_JOURNAL_INVALID", ...(cause ? { cause } : {}) })
}

function invalidJournalThrow(): never {
  throw invalidJournal()
}

function symlinkError(path: string) {
  return new PixiuError(`Workspace change path contains a symbolic link: ${path}`, { code: "WORKSPACE_PATH_SYMLINK" })
}

function invalidTarget(path: string) {
  return new PixiuError(`Workspace change target is not a regular file: ${path}`, { code: "WORKSPACE_CHANGE_TARGET_INVALID" })
}

function noFollowFlag() {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
}

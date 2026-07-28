import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { homedir } from "node:os"

import { isInside } from "../sandbox/path"
import { PixiuError } from "../shared/errors"
import { workspaceRevision } from "./diff"

export const SESSION_WORKSPACE_META_VERSION = 1

export type SessionWorkspaceProjectIdentity = {
  device: string
  inode: string
}

export type SessionWorkspaceSource =
  | { kind: "directory" }
  | { kind: "git"; repositoryRoot: string; head?: string }

export type SessionWorkspaceBinding = {
  version: typeof SESSION_WORKSPACE_META_VERSION
  sessionId: string
  projectId?: string
  projectRoot: string
  projectIdentity: SessionWorkspaceProjectIdentity
  stateRoot: string
  root: string
  baselineRoot: string
  workRoot: string
  metaPath: string
  baseRevision: string
  createdAt: string
  source: SessionWorkspaceSource
  excludedPaths: string[]
}

export type CreateSessionWorkspaceBindingOptions = {
  stateRoot: string
  projectRoot: string
  sessionId: string
  projectId?: string
  excludePaths?: string[]
}

export type LoadSessionWorkspaceBindingOptions = Pick<
  CreateSessionWorkspaceBindingOptions,
  "stateRoot" | "projectRoot" | "sessionId"
> & {
  verifyBaseline?: boolean
}

export type SessionWorkspaceScope = "baseline" | "work"

const META_FILE = "meta.json"
const BASELINE_DIRECTORY = "baseline"
const WORK_DIRECTORY = "work"
const COPY_BUFFER_BYTES = 64 * 1024
const DEFAULT_EXCLUDED_NAMES = new Set([".git", ".pixiu", ".tools", ".venv", "node_modules", "pwd"])

export function sessionWorkspaceProjectExcludePaths(configuredPath = "workspace") {
  if (isAbsolute(configuredPath)) return []
  return [normalizeRelativePath(configuredPath, "SESSION_WORKSPACE_STATE_INVALID")]
}

export function resolveSessionWorkspaceStateRoot(configuredPath = "workspace") {
  if (isAbsolute(configuredPath)) return resolve(configuredPath)
  const relativePath = normalizeRelativePath(configuredPath, "SESSION_WORKSPACE_STATE_INVALID")
  const configuredStateHome = process.env.XDG_STATE_HOME?.trim()
  const stateHome = configuredStateHome && isAbsolute(configuredStateHome)
    ? resolve(configuredStateHome)
    : join(homedir(), ".local", "state")
  return join(stateHome, "pixiu", relativePath)
}

export async function createSessionWorkspaceBinding(
  options: CreateSessionWorkspaceBindingOptions,
): Promise<SessionWorkspaceBinding> {
  const sessionId = normalizeSessionId(options.sessionId)
  const projectRoot = await canonicalProjectRoot(options.projectRoot)
  const stateRoot = await canonicalExternalStateRoot(options.stateRoot, projectRoot)
  const excludePaths = normalizeExcludedPaths(options.excludePaths ?? [])
  const root = bindingRoot(stateRoot, projectRoot, sessionId)
  const parent = dirname(root)
  await ensureContainedDirectories(stateRoot, parent)
  await assertBindingDoesNotExist(root)

  const temporaryRoot = await mkdtemp(join(parent, `.${sessionId}.tmp-`))
  const finalBaselineRoot = join(root, BASELINE_DIRECTORY)
  const finalWorkRoot = join(root, WORK_DIRECTORY)
  const temporaryBaselineRoot = join(temporaryRoot, BASELINE_DIRECTORY)
  const temporaryWorkRoot = join(temporaryRoot, WORK_DIRECTORY)
  try {
    await mkdir(temporaryBaselineRoot, { recursive: true, mode: 0o700 })
    await copyWorkspaceTree(projectRoot, temporaryBaselineRoot, { excludePaths })
    await mkdir(temporaryWorkRoot, { recursive: true, mode: 0o700 })
    await copyWorkspaceTree(temporaryBaselineRoot, temporaryWorkRoot, { excludePaths: [] })
    const [baseRevision, projectInfo, source] = await Promise.all([
      workspaceRevision(temporaryBaselineRoot),
      stat(projectRoot),
      detectWorkspaceSource(projectRoot),
    ])
    const binding: SessionWorkspaceBinding = {
      version: SESSION_WORKSPACE_META_VERSION,
      sessionId,
      ...(options.projectId?.trim() ? { projectId: options.projectId.trim() } : {}),
      projectRoot,
      projectIdentity: projectIdentity(projectInfo),
      stateRoot,
      root,
      baselineRoot: finalBaselineRoot,
      workRoot: finalWorkRoot,
      metaPath: join(root, META_FILE),
      baseRevision,
      createdAt: new Date().toISOString(),
      source,
      excludedPaths: excludePaths,
    }
    await writeFile(join(temporaryRoot, META_FILE), `${JSON.stringify(binding, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await protectBaseline(temporaryBaselineRoot)
    await assertBindingDoesNotExist(root)
    await rename(temporaryRoot, root)
    return binding
  } catch (cause) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    if (cause instanceof PixiuError) throw cause
    throw new PixiuError(`Failed to create session workspace ${sessionId}.`, {
      code: "SESSION_WORKSPACE_CREATE_FAILED",
      cause,
    })
  }
}

export async function loadSessionWorkspaceBinding(
  options: LoadSessionWorkspaceBindingOptions,
): Promise<SessionWorkspaceBinding> {
  const sessionId = normalizeSessionId(options.sessionId)
  const projectRoot = await canonicalProjectRoot(options.projectRoot)
  const stateRoot = await canonicalExternalStateRoot(options.stateRoot, projectRoot)
  const root = bindingRoot(stateRoot, projectRoot, sessionId)
  const metaPath = join(root, META_FILE)
  await requireContainedDirectory(stateRoot, root)
  await requirePlainFile(metaPath, "SESSION_WORKSPACE_META_INVALID")

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(metaPath, "utf8"))
  } catch (cause) {
    throw new PixiuError(`Invalid session workspace metadata: ${metaPath}`, {
      code: "SESSION_WORKSPACE_META_INVALID",
      cause,
    })
  }
  const binding = normalizeBinding(parsed)
  const expected = {
    sessionId,
    projectRoot,
    stateRoot,
    root,
    baselineRoot: join(root, BASELINE_DIRECTORY),
    workRoot: join(root, WORK_DIRECTORY),
    metaPath,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (binding[key as keyof SessionWorkspaceBinding] !== value) {
      throw new PixiuError(`Session workspace metadata does not match ${key}.`, { code: "SESSION_WORKSPACE_META_MISMATCH" })
    }
  }

  const projectInfo = await stat(projectRoot)
  if (!sameProjectIdentity(binding.projectIdentity, projectIdentity(projectInfo))) {
    throw new PixiuError("The bound project root has been replaced since this session was created.", {
      code: "SESSION_WORKSPACE_PROJECT_REPLACED",
    })
  }
  await Promise.all([
    requireContainedDirectory(root, binding.baselineRoot),
    requireContainedDirectory(root, binding.workRoot),
  ])
  if (options.verifyBaseline !== false) {
    const revision = await workspaceRevision(binding.baselineRoot)
    if (revision !== binding.baseRevision) {
      throw new PixiuError("The session workspace baseline has been modified.", {
        code: "SESSION_WORKSPACE_BASELINE_CHANGED",
      })
    }
  }
  return binding
}

export async function resolveSessionWorkspacePath(
  binding: SessionWorkspaceBinding,
  scope: SessionWorkspaceScope,
  path: string,
  options: { allowMissing?: boolean } = {},
) {
  const root = scope === "baseline" ? binding.baselineRoot : binding.workRoot
  const relativePath = normalizeRelativePath(path, "WORKSPACE_PATH_INVALID")
  const target = resolve(root, relativePath)
  if (!isInside(root, target)) {
    throw new PixiuError(`Path escapes workspace: ${path}`, { code: "PATH_OUTSIDE_WORKSPACE" })
  }
  await assertNoSymlinkComponents(root, target, options.allowMissing === true)
  return {
    absolutePath: target,
    relativePath: relative(root, target).split(sep).join("/") || ".",
  }
}

export function sessionWorkspaceBindingPath(input: { stateRoot: string; projectRoot: string; sessionId: string }) {
  const sessionId = normalizeSessionId(input.sessionId)
  return bindingRoot(resolve(input.stateRoot), resolve(input.projectRoot), sessionId)
}

async function canonicalProjectRoot(path: string) {
  const requested = resolve(path)
  let info
  try {
    info = await lstat(requested)
  } catch (cause) {
    throw new PixiuError(`Project root is unavailable: ${requested}`, { code: "PROJECT_ROOT_UNAVAILABLE", cause })
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PixiuError(`Project root must be a real directory: ${requested}`, { code: "PROJECT_ROOT_INVALID" })
  }
  return await realpath(requested)
}

async function canonicalExternalStateRoot(path: string, projectRoot: string) {
  const requested = resolve(path)
  const potential = await canonicalPotentialPath(requested)
  assertRootsDoNotOverlap(projectRoot, potential)
  await mkdir(requested, { recursive: true, mode: 0o700 })
  const canonical = await realpath(requested)
  assertRootsDoNotOverlap(projectRoot, canonical)
  return canonical
}

async function canonicalPotentialPath(path: string) {
  let current = path
  const missing: string[] = []
  while (true) {
    try {
      const parent = await realpath(current)
      return resolve(parent, ...missing.reverse())
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

function assertRootsDoNotOverlap(projectRoot: string, stateRoot: string) {
  if (isInside(projectRoot, stateRoot) || isInside(stateRoot, projectRoot)) {
    throw new PixiuError("Session workspace state must be outside and separate from the project root.", {
      code: "SESSION_WORKSPACE_ROOT_OVERLAP",
    })
  }
}

function bindingRoot(stateRoot: string, projectRoot: string, sessionId: string) {
  const projectKey = createHash("sha256").update(projectRoot).digest("hex").slice(0, 24)
  return join(stateRoot, "projects", projectKey, "sessions", sessionId)
}

async function assertBindingDoesNotExist(path: string) {
  try {
    await lstat(path)
  } catch (error: any) {
    if (error?.code === "ENOENT") return
    throw error
  }
  throw new PixiuError(`Session workspace already exists: ${path}`, { code: "SESSION_WORKSPACE_EXISTS" })
}

async function copyWorkspaceTree(sourceRoot: string, destinationRoot: string, options: { excludePaths: string[] }) {
  const source = await realpath(sourceRoot)
  await copyDirectory(source, source, destinationRoot, options.excludePaths)
}

async function copyDirectory(sourceRoot: string, sourceDirectory: string, destinationDirectory: string, excludePaths: string[]) {
  const children = await readdir(sourceDirectory, { withFileTypes: true })
  children.sort((left, right) => left.name.localeCompare(right.name))
  for (const child of children) {
    const sourcePath = join(sourceDirectory, child.name)
    const relativePath = relative(sourceRoot, sourcePath).split(sep).join("/")
    if (isExcluded(relativePath, excludePaths)) continue
    const destinationPath = join(destinationDirectory, child.name)
    const info = await lstat(sourcePath)
    if (info.isSymbolicLink()) {
      const target = await readlink(sourcePath)
      await assertSafeSourceSymlink(sourceRoot, sourcePath, target)
      await symlink(target, destinationPath)
      continue
    }
    if (info.isDirectory()) {
      await mkdir(destinationPath, { mode: directoryMode(info.mode) })
      await copyDirectory(sourceRoot, sourcePath, destinationPath, excludePaths)
      await chmod(destinationPath, directoryMode(info.mode))
      continue
    }
    if (!info.isFile()) {
      throw new PixiuError(`Unsupported project entry: ${relativePath}`, { code: "WORKSPACE_ENTRY_UNSUPPORTED" })
    }
    await copyFileNoFollow(sourcePath, destinationPath, fileMode(info.mode))
  }
}

async function copyFileNoFollow(sourcePath: string, destinationPath: string, mode: number) {
  const source = await open(sourcePath, constants.O_RDONLY | noFollowFlag())
  let destination
  try {
    const info = await source.stat()
    if (!info.isFile()) throw new PixiuError(`Project entry changed while copying: ${sourcePath}`, { code: "WORKSPACE_ENTRY_CHANGED" })
    destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let position = 0
    while (position < info.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, info.size - position), position)
      if (!bytesRead) break
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written)
        written += result.bytesWritten
      }
      position += bytesRead
    }
    if (position !== info.size) throw new PixiuError(`Project entry changed while copying: ${sourcePath}`, { code: "WORKSPACE_ENTRY_CHANGED" })
    await destination.sync()
    await destination.chmod(mode)
  } finally {
    await destination?.close().catch(() => undefined)
    await source.close().catch(() => undefined)
  }
}

async function assertSafeSourceSymlink(sourceRoot: string, sourcePath: string, target: string) {
  if (isAbsolute(target) || !isInside(sourceRoot, resolve(dirname(sourcePath), target))) {
    throw new PixiuError(`Project symlink escapes the project root: ${relative(sourceRoot, sourcePath)}`, {
      code: "WORKSPACE_SYMLINK_UNSAFE",
    })
  }
  try {
    const resolvedTarget = await realpath(sourcePath)
    if (!isInside(sourceRoot, resolvedTarget)) {
      throw new PixiuError(`Project symlink escapes the project root: ${relative(sourceRoot, sourcePath)}`, {
        code: "WORKSPACE_SYMLINK_UNSAFE",
      })
    }
  } catch (error: any) {
    if (error instanceof PixiuError) throw error
    if (error?.code === "ENOENT") return
    throw error
  }
}

async function protectBaseline(root: string) {
  const children = await readdir(root, { withFileTypes: true })
  for (const child of children) {
    const path = join(root, child.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      await protectBaseline(path)
      await chmod(path, readOnlyDirectoryMode(info.mode))
      continue
    }
    if (info.isFile()) await chmod(path, readOnlyFileMode(info.mode))
  }
  const info = await lstat(root)
  await chmod(root, readOnlyDirectoryMode(info.mode))
}

async function detectWorkspaceSource(projectRoot: string): Promise<SessionWorkspaceSource> {
  const repository = await runGitRead(projectRoot, ["rev-parse", "--show-toplevel"])
  if (!repository.ok || !repository.stdout.trim()) return { kind: "directory" }
  let repositoryRoot: string
  try {
    repositoryRoot = await realpath(repository.stdout.trim())
  } catch {
    return { kind: "directory" }
  }
  if (!isInside(repositoryRoot, projectRoot)) return { kind: "directory" }
  const head = await runGitRead(projectRoot, ["rev-parse", "--verify", "HEAD"])
  return {
    kind: "git",
    repositoryRoot,
    ...(head.ok && head.stdout.trim() ? { head: head.stdout.trim() } : {}),
  }
}

async function runGitRead(cwd: string, args: string[]) {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn({
      cmd: ["git", "--no-optional-locks", ...args],
      cwd,
      env: gitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    return { ok: false, stdout: "" }
  }
  const timeout = setTimeout(() => child.kill(), 5_000)
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      child.exited,
    ])
    return { ok: exitCode === 0, stdout: stdout.slice(0, 8_192) }
  } finally {
    clearTimeout(timeout)
  }
}

function gitEnvironment() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key]
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  }
}

async function requirePlainFile(path: string, code: string) {
  let info
  try {
    info = await lstat(path)
  } catch (cause) {
    throw new PixiuError(`Session workspace metadata is unavailable: ${path}`, { code, cause })
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new PixiuError(`Expected a regular file: ${path}`, { code })
}

async function requireContainedDirectory(root: string, path: string) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PixiuError(`Session workspace directory is invalid: ${path}`, { code: "SESSION_WORKSPACE_INVALID" })
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)])
  if (!isInside(canonicalRoot, canonicalPath)) {
    throw new PixiuError(`Session workspace path escapes its binding: ${path}`, { code: "PATH_OUTSIDE_WORKSPACE" })
  }
}

async function ensureContainedDirectories(rootPath: string, targetPath: string) {
  const root = await realpath(rootPath)
  const target = resolve(targetPath)
  if (!isInside(root, target)) {
    throw new PixiuError(`Session workspace state path escapes its root: ${target}`, { code: "PATH_OUTSIDE_WORKSPACE" })
  }
  const parts = relative(root, target).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (mkdirError: any) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError
      }
      info = await lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new PixiuError(`Session workspace state contains an unsafe path component: ${current}`, {
        code: "SESSION_WORKSPACE_STATE_UNSAFE",
      })
    }
    if (!isInside(root, await realpath(current))) {
      throw new PixiuError(`Session workspace state path escapes its root: ${current}`, { code: "PATH_OUTSIDE_WORKSPACE" })
    }
  }
}

async function assertNoSymlinkComponents(rootPath: string, targetPath: string, allowMissing: boolean) {
  const root = await realpath(rootPath)
  const target = resolve(targetPath)
  if (!isInside(root, target)) throw new PixiuError(`Path escapes workspace: ${target}`, { code: "PATH_OUTSIDE_WORKSPACE" })
  const parts = relative(root, target).split(sep).filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        throw new PixiuError(`Workspace path contains a symlink: ${relative(root, current)}`, { code: "WORKSPACE_PATH_SYMLINK" })
      }
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new PixiuError(`Workspace path parent is not a directory: ${relative(root, current)}`, { code: "WORKSPACE_PATH_INVALID" })
      }
    } catch (error: any) {
      if (error instanceof PixiuError) throw error
      if (error?.code === "ENOENT" && allowMissing) return
      if (error?.code === "ENOENT") {
        throw new PixiuError(`Unknown workspace path: ${relative(root, target)}`, { code: "WORKSPACE_PATH_NOT_FOUND", cause: error })
      }
      throw error
    }
  }
}

function normalizeBinding(value: unknown): SessionWorkspaceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidMeta()
  const input = value as Record<string, unknown>
  if (input.version !== SESSION_WORKSPACE_META_VERSION) throw invalidMeta()
  const sessionId = stringValue(input.sessionId)
  const projectRoot = stringValue(input.projectRoot)
  const stateRoot = stringValue(input.stateRoot)
  const root = stringValue(input.root)
  const baselineRoot = stringValue(input.baselineRoot)
  const workRoot = stringValue(input.workRoot)
  const metaPath = stringValue(input.metaPath)
  const baseRevision = stringValue(input.baseRevision)
  const createdAt = stringValue(input.createdAt)
  const projectIdentityValue = objectValue(input.projectIdentity)
  const device = stringValue(projectIdentityValue.device)
  const inode = stringValue(projectIdentityValue.inode)
  const source = normalizeSource(input.source)
  const excludedPaths = Array.isArray(input.excludedPaths) && input.excludedPaths.every((item) => typeof item === "string")
    ? input.excludedPaths as string[]
    : undefined
  if (!sessionId || !projectRoot || !stateRoot || !root || !baselineRoot || !workRoot || !metaPath || !baseRevision || !createdAt || !device || !inode || !source || !excludedPaths) {
    throw invalidMeta()
  }
  return {
    version: SESSION_WORKSPACE_META_VERSION,
    sessionId: normalizeSessionId(sessionId),
    ...(stringValue(input.projectId) ? { projectId: stringValue(input.projectId)! } : {}),
    projectRoot,
    projectIdentity: { device, inode },
    stateRoot,
    root,
    baselineRoot,
    workRoot,
    metaPath,
    baseRevision,
    createdAt,
    source,
    excludedPaths: normalizeExcludedPaths(excludedPaths),
  }
}

function normalizeSource(value: unknown): SessionWorkspaceSource | undefined {
  const input = objectValue(value)
  if (input.kind === "directory") return { kind: "directory" }
  if (input.kind !== "git") return undefined
  const repositoryRoot = stringValue(input.repositoryRoot)
  if (!repositoryRoot) return undefined
  const head = stringValue(input.head)
  return { kind: "git", repositoryRoot, ...(head ? { head } : {}) }
}

function invalidMeta() {
  return new PixiuError("Session workspace metadata is invalid.", { code: "SESSION_WORKSPACE_META_INVALID" })
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function projectIdentity(info: Stats): SessionWorkspaceProjectIdentity {
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameProjectIdentity(left: SessionWorkspaceProjectIdentity, right: SessionWorkspaceProjectIdentity) {
  return left.device === right.device && left.inode === right.inode
}

function normalizeSessionId(value: string) {
  const sessionId = value.trim()
  if (!sessionId || sessionId.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new PixiuError("sessionId contains unsafe path characters.", { code: "SESSION_WORKSPACE_ID_INVALID" })
  }
  return sessionId
}

function normalizeExcludedPaths(paths: string[]) {
  return [...new Set(paths.map((path) => normalizeRelativePath(path, "SESSION_WORKSPACE_EXCLUDE_INVALID")))].sort()
}

function normalizeRelativePath(value: string, code: string) {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  const normalized = path.split("/").filter((part) => part && part !== ".")
  if (!path || path.includes("\0") || !normalized.length || isAbsolute(path) || normalized.some((part) => part === "..")) {
    throw new PixiuError(`Invalid relative workspace path: ${value}`, { code })
  }
  return normalized.join("/")
}

function isExcluded(path: string, excludedPaths: string[]) {
  const parts = path.split("/")
  if (parts.some((part) => DEFAULT_EXCLUDED_NAMES.has(part))) return true
  return excludedPaths.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))
}

function directoryMode(mode: number) {
  return mode & 0o777 || 0o700
}

function fileMode(mode: number) {
  return mode & 0o777 || 0o600
}

function readOnlyDirectoryMode(mode: number) {
  return mode & 0o555 || 0o500
}

function readOnlyFileMode(mode: number) {
  return mode & 0o111 ? 0o555 : 0o444
}

function noFollowFlag() {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
}

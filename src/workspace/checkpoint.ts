import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { isInside } from "../sandbox/path"
import { PixiuError } from "../shared/errors"
import { createID } from "../shared/id"
import { workspaceRevision } from "./diff"
import type { SessionWorkspaceBinding } from "./session"

export type WorkspaceCheckpoint = {
  version: 1
  id: string
  sessionId: string
  turnId: string
  revision: string
  createdAt: string
}

const CHECKPOINTS_DIRECTORY = "checkpoints"
const CHECKPOINT_META = "meta.json"
const CHECKPOINT_TREE = "tree"
const MAX_CHECKPOINTS = 50

export async function createWorkspaceCheckpoint(
  binding: SessionWorkspaceBinding,
  turnId: string,
): Promise<WorkspaceCheckpoint> {
  const safeTurnId = safeId(turnId, "TURN_ID_INVALID")
  const checkpointsRoot = await requireCheckpointsRoot(binding)
  const id = createID("checkpoint")
  const target = join(checkpointsRoot, id)
  const temporary = await mkdtemp(join(checkpointsRoot, ".create-"))
  try {
    const revision = await workspaceRevision(binding.workRoot)
    await cp(binding.workRoot, join(temporary, CHECKPOINT_TREE), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
    const checkpoint: WorkspaceCheckpoint = {
      version: 1,
      id,
      sessionId: binding.sessionId,
      turnId: safeTurnId,
      revision,
      createdAt: new Date().toISOString(),
    }
    await writeFile(join(temporary, CHECKPOINT_META), `${JSON.stringify(checkpoint, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await rename(temporary, target)
    await pruneCheckpoints(checkpointsRoot)
    return checkpoint
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    if (cause instanceof PixiuError) throw cause
    throw new PixiuError("Failed to create the turn checkpoint.", { code: "CHECKPOINT_CREATE_FAILED", cause })
  }
}

export async function restoreWorkspaceCheckpoint(
  binding: SessionWorkspaceBinding,
  checkpointId: string,
): Promise<WorkspaceCheckpoint> {
  const checkpoint = await loadWorkspaceCheckpoint(binding, checkpointId)
  const checkpointsRoot = await requireCheckpointsRoot(binding)
  const checkpointRoot = join(checkpointsRoot, checkpoint.id)
  const tree = join(checkpointRoot, CHECKPOINT_TREE)
  await requireContainedDirectory(checkpointRoot, tree, "CHECKPOINT_INVALID")
  if (await workspaceRevision(tree) !== checkpoint.revision) {
    throw new PixiuError("Checkpoint contents have changed.", { code: "CHECKPOINT_CHANGED" })
  }

  const temporary = await mkdtemp(join(binding.root, ".restore-"))
  const restored = join(temporary, "work")
  const backup = join(binding.root, `.work-backup-${checkpoint.id}`)
  let movedCurrent = false
  try {
    await cp(tree, restored, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
    if (await workspaceRevision(restored) !== checkpoint.revision) {
      throw new PixiuError("Restored checkpoint does not match its revision.", { code: "CHECKPOINT_RESTORE_INVALID" })
    }
    await requireContainedDirectory(binding.root, binding.workRoot, "SESSION_WORKSPACE_INVALID")
    await rename(binding.workRoot, backup)
    movedCurrent = true
    await rename(restored, binding.workRoot)
    movedCurrent = false
    await rm(backup, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
    return checkpoint
  } catch (cause) {
    if (movedCurrent) await rename(backup, binding.workRoot).catch(() => undefined)
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    if (cause instanceof PixiuError) throw cause
    throw new PixiuError("Failed to restore the turn checkpoint.", { code: "CHECKPOINT_RESTORE_FAILED", cause })
  }
}

export async function loadWorkspaceCheckpoint(
  binding: SessionWorkspaceBinding,
  checkpointId: string,
): Promise<WorkspaceCheckpoint> {
  const id = safeId(checkpointId, "CHECKPOINT_ID_INVALID")
  const checkpointsRoot = await requireCheckpointsRoot(binding)
  const root = join(checkpointsRoot, id)
  await requireContainedDirectory(checkpointsRoot, root, "CHECKPOINT_NOT_FOUND")
  const metaPath = join(root, CHECKPOINT_META)
  const info = await lstat(metaPath).catch((cause) => {
    throw new PixiuError(`Unknown checkpoint: ${id}`, { code: "CHECKPOINT_NOT_FOUND", cause })
  })
  if (info.isSymbolicLink() || !info.isFile()) throw new PixiuError("Checkpoint metadata is invalid.", { code: "CHECKPOINT_INVALID" })
  let value: unknown
  try {
    value = JSON.parse(await readFile(metaPath, "utf8"))
  } catch (cause) {
    throw new PixiuError("Checkpoint metadata is invalid.", { code: "CHECKPOINT_INVALID", cause })
  }
  const checkpoint = normalizeCheckpoint(value)
  if (checkpoint.id !== id || checkpoint.sessionId !== binding.sessionId) {
    throw new PixiuError("Checkpoint metadata does not match this session.", { code: "CHECKPOINT_INVALID" })
  }
  return checkpoint
}

async function requireCheckpointsRoot(binding: SessionWorkspaceBinding) {
  const root = join(binding.root, CHECKPOINTS_DIRECTORY)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await requireContainedDirectory(binding.root, root, "CHECKPOINT_STATE_INVALID")
  return await realpath(root)
}

async function requireContainedDirectory(parent: string, path: string, code: string) {
  let info
  try {
    info = await lstat(path)
  } catch (cause) {
    throw new PixiuError(`Directory is unavailable: ${path}`, { code, cause })
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PixiuError(`Unsafe directory: ${path}`, { code })
  const [canonicalParent, canonicalPath] = await Promise.all([realpath(parent), realpath(path)])
  if (!isInside(canonicalParent, canonicalPath)) throw new PixiuError(`Directory escapes checkpoint state: ${path}`, { code })
}

async function pruneCheckpoints(root: string) {
  const entries = await readdir(root, { withFileTypes: true })
  const checkpoints: Array<{ id: string; createdAt: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    try {
      const value = JSON.parse(await readFile(join(root, entry.name, CHECKPOINT_META), "utf8")) as Record<string, unknown>
      checkpoints.push({ id: entry.name, createdAt: typeof value.createdAt === "string" ? value.createdAt : "" })
    } catch {
      // Invalid entries are retained for explicit diagnostics rather than silently deleted.
    }
  }
  checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  await Promise.all(checkpoints.slice(MAX_CHECKPOINTS).map((checkpoint) => rm(join(root, checkpoint.id), { recursive: true, force: true })))
}

function normalizeCheckpoint(value: unknown): WorkspaceCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PixiuError("Checkpoint metadata is invalid.", { code: "CHECKPOINT_INVALID" })
  }
  const item = value as Record<string, unknown>
  const id = typeof item.id === "string" ? safeId(item.id, "CHECKPOINT_INVALID") : undefined
  const sessionId = typeof item.sessionId === "string" ? safeId(item.sessionId, "CHECKPOINT_INVALID") : undefined
  const turnId = typeof item.turnId === "string" ? safeId(item.turnId, "CHECKPOINT_INVALID") : undefined
  const revision = typeof item.revision === "string" && /^[a-f0-9]{64}$/.test(item.revision) ? item.revision : undefined
  const createdAt = typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : undefined
  if (item.version !== 1 || !id || !sessionId || !turnId || !revision || !createdAt) {
    throw new PixiuError("Checkpoint metadata is invalid.", { code: "CHECKPOINT_INVALID" })
  }
  return { version: 1, id, sessionId, turnId, revision, createdAt }
}

function safeId(value: string, code: string) {
  const id = value.trim()
  if (!id || id.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) || resolve("/", id) !== join("/", id)) {
    throw new PixiuError("Identifier contains unsafe path characters.", { code })
  }
  return id
}

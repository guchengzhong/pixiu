import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

import { buildAllowedEnv } from "../sandbox/shell"
import { isInside } from "../sandbox/path"
import { PixiuError } from "../shared/errors"
import { createID } from "../shared/id"
import { redactSecrets } from "../shared/redact"
import type { SessionWorkspaceBinding } from "./session"

export type WorkspaceValidationKind = "test" | "typecheck" | "build" | "custom"
export type WorkspaceValidationStatus = "passed" | "failed" | "cancelled"
export type WorkspaceValidationPresets = Partial<Record<Exclude<WorkspaceValidationKind, "custom">, string>>

export type WorkspaceValidationRequest = {
  sessionId: string
  turnId: string
  revision: string
  kind: unknown
  command?: unknown
}

export type ResolvedWorkspaceValidation = {
  kind: WorkspaceValidationKind
  command: string
}

export type WorkspaceValidationRecord = {
  id: string
  sessionId: string
  turnId: string
  revision: string
  kind: WorkspaceValidationKind
  command: string
  status: WorkspaceValidationStatus
  startedAt: string
  completedAt: string
  durationMs: number
  exitCode: number
  output: string
  truncated: boolean
  timedOut: boolean
}

export type RunWorkspaceValidationOptions = {
  presets?: WorkspaceValidationPresets
  timeoutMs?: number
  outputMaxBytes?: number
  envAllowlist?: string[]
  envPrependPath?: string[]
  signal?: AbortSignal
  shell?: string
}

export type WorkspaceValidationKey = Pick<WorkspaceValidationRecord, "sessionId" | "turnId" | "revision">

const VALIDATIONS_FILE = "validations.jsonl"
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_MAX_BYTES = 20_000
const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "SHELL", "TMPDIR"]
const MIN_OUTPUT_MAX_BYTES = 1
const MAX_OUTPUT_MAX_BYTES = 10 * 1024 * 1024
const MAX_TIMEOUT_MS = 30 * 60_000
const MAX_COMMAND_LENGTH = 32_768
const TRUNCATION_MARKER = "...[output truncated]"

export function resolveWorkspaceValidation(
  request: Pick<WorkspaceValidationRequest, "kind" | "command">,
  presets: WorkspaceValidationPresets = {},
): ResolvedWorkspaceValidation {
  const kind = validationKind(request.kind)
  if (kind === "custom") {
    return { kind, command: validationCommand(request.command, "custom validation command") }
  }
  if (request.command !== undefined) {
    throw new PixiuError(`The ${kind} preset command cannot be overridden by the request.`, {
      code: "WORKSPACE_VALIDATION_PRESET_OVERRIDE",
    })
  }
  const command = presets[kind]
  if (command === undefined) {
    throw new PixiuError(`No ${kind} validation preset is configured.`, {
      code: "WORKSPACE_VALIDATION_PRESET_UNAVAILABLE",
    })
  }
  return { kind, command: validationCommand(command, `${kind} validation preset`) }
}

export async function runWorkspaceValidation(
  binding: SessionWorkspaceBinding,
  request: WorkspaceValidationRequest,
  options: RunWorkspaceValidationOptions = {},
): Promise<WorkspaceValidationRecord> {
  const key = validationKey(binding, request)
  const resolved = resolveWorkspaceValidation(request, options.presets)
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, "timeoutMs")
  const outputMaxBytes = boundedInteger(
    options.outputMaxBytes,
    DEFAULT_OUTPUT_MAX_BYTES,
    MIN_OUTPUT_MAX_BYTES,
    MAX_OUTPUT_MAX_BYTES,
    "outputMaxBytes",
  )
  await requireSafeWorkRoot(binding)

  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  if (options.signal?.aborted) {
    const output = boundedRedactedOutput("Validation cancelled before it started.", outputMaxBytes, false)
    return await persistWorkspaceValidationRecord(binding, validationRecord({
      ...key,
      resolved,
      started,
      startedAt,
      status: "cancelled",
      exitCode: 130,
      output: output.text,
      truncated: output.truncated,
      timedOut: false,
    }))
  }

  const shell = validationCommand(
    options.shell ?? (process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh"),
    "validation shell",
  )
  const shellArgs = process.platform === "win32"
    ? [shell, "/d", "/s", "/c", resolved.command]
    : [shell, "-c", resolved.command]
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn({
      cmd: shellArgs,
      cwd: binding.workRoot,
      detached: true,
      env: buildAllowedEnv(options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST, {
        ...(options.envPrependPath ? { prependPath: options.envPrependPath } : {}),
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (cause) {
    const output = boundedRedactedOutput(
      `Failed to start validation: ${cause instanceof Error ? cause.message : String(cause)}`,
      outputMaxBytes,
      false,
    )
    return await persistWorkspaceValidationRecord(binding, validationRecord({
      ...key,
      resolved,
      started,
      startedAt,
      status: "failed",
      exitCode: 127,
      output: output.text,
      truncated: output.truncated,
      timedOut: false,
    }))
  }

  let timedOut = false
  let aborted = false
  let finished = false
  let hardKill: ReturnType<typeof setTimeout> | undefined
  const terminate = (reason: "abort" | "timeout") => {
    if (finished) return
    if (reason === "timeout") timedOut = true
    else aborted = true
    killValidationProcess(child, "SIGTERM")
    hardKill ??= setTimeout(() => {
      if (!finished) killValidationProcess(child, "SIGKILL")
    }, 250)
  }
  const abort = () => terminate("abort")
  options.signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => terminate("timeout"), timeoutMs)
  const budget = { remaining: outputMaxBytes, truncated: false }

  let stdout = ""
  let stderr = ""
  let childExitCode: number
  try {
    [stdout, stderr, childExitCode] = await Promise.all([
      readBoundedOutput(child.stdout as ReadableStream<Uint8Array>, budget),
      readBoundedOutput(child.stderr as ReadableStream<Uint8Array>, budget),
      child.exited,
    ])
  } finally {
    finished = true
    clearTimeout(timeout)
    if (hardKill) clearTimeout(hardKill)
    options.signal?.removeEventListener("abort", abort)
  }

  const status: WorkspaceValidationStatus = timedOut
    ? "failed"
    : aborted || options.signal?.aborted
      ? "cancelled"
      : childExitCode === 0
        ? "passed"
        : "failed"
  const exitCode = timedOut ? 124 : status === "cancelled" ? 130 : childExitCode
  const diagnostic = timedOut
    ? `Validation timed out after ${timeoutMs}ms.`
    : status === "cancelled"
      ? "Validation cancelled."
      : ""
  const combined = [stdout, stderr, diagnostic].filter(Boolean).join("\n")
  const output = boundedRedactedOutput(combined, outputMaxBytes, budget.truncated)
  return await persistWorkspaceValidationRecord(binding, validationRecord({
    ...key,
    resolved,
    started,
    startedAt,
    status,
    exitCode,
    output: output.text,
    truncated: output.truncated,
    timedOut,
  }))
}

export async function persistWorkspaceValidationRecord(
  binding: SessionWorkspaceBinding,
  record: WorkspaceValidationRecord,
): Promise<WorkspaceValidationRecord> {
  await requireSafeBindingRoot(binding)
  const normalized = normalizeRecord({
    ...record,
    command: redactSecrets(record.command),
    output: redactSecrets(record.output),
  })
  if (normalized.sessionId !== binding.sessionId) {
    throw new PixiuError("Validation session does not match its workspace binding.", {
      code: "WORKSPACE_VALIDATION_SESSION_MISMATCH",
    })
  }
  const path = join(binding.root, VALIDATIONS_FILE)
  let handle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollowFlag(), 0o600)
    await requirePlainStoreHandle(handle)
    await handle.chmod(0o600)
    await handle.writeFile(`${JSON.stringify(normalized)}\n`, "utf8")
  } catch (cause) {
    if (cause instanceof PixiuError) throw cause
    throw invalidValidationStore(cause)
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return normalized
}

export async function readWorkspaceValidationRecords(
  binding: SessionWorkspaceBinding,
  query: WorkspaceValidationKey,
): Promise<WorkspaceValidationRecord[]> {
  const key = validationKey(binding, query)
  return (await listWorkspaceValidationRecords(binding)).filter((record) => (
    record.sessionId === key.sessionId && record.turnId === key.turnId && record.revision === key.revision
  ))
}

export async function listWorkspaceValidationRecords(
  binding: SessionWorkspaceBinding,
): Promise<WorkspaceValidationRecord[]> {
  await requireSafeBindingRoot(binding)
  const path = join(binding.root, VALIDATIONS_FILE)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag())
    await requirePlainStoreHandle(handle)
    const content = await handle.readFile("utf8")

    const records: WorkspaceValidationRecord[] = []
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      try {
        const record = normalizeRecord(JSON.parse(line))
        if (record.sessionId !== binding.sessionId) throw new Error("session does not match binding")
        records.push(record)
      } catch (cause) {
        throw new PixiuError(`Invalid workspace validation store at line ${index + 1}.`, {
          code: "WORKSPACE_VALIDATION_STORE_INVALID",
          cause,
        })
      }
    }
    return records
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return []
    if (cause instanceof PixiuError) throw cause
    throw invalidValidationStore(cause)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function validationRecord(input: {
  sessionId: string
  turnId: string
  revision: string
  resolved: ResolvedWorkspaceValidation
  started: number
  startedAt: string
  status: WorkspaceValidationStatus
  exitCode: number
  output: string
  truncated: boolean
  timedOut: boolean
}): WorkspaceValidationRecord {
  const completed = Date.now()
  return {
    id: createID("validation"),
    sessionId: input.sessionId,
    turnId: input.turnId,
    revision: input.revision,
    kind: input.resolved.kind,
    command: redactSecrets(input.resolved.command),
    status: input.status,
    startedAt: input.startedAt,
    completedAt: new Date(completed).toISOString(),
    durationMs: Math.max(0, completed - input.started),
    exitCode: input.exitCode,
    output: input.output,
    truncated: input.truncated,
    timedOut: input.timedOut,
  }
}

function validationKey(binding: SessionWorkspaceBinding, input: WorkspaceValidationKey) {
  const sessionId = validationIdentifier(input.sessionId, "sessionId")
  if (sessionId !== binding.sessionId) {
    throw new PixiuError("Validation session does not match its workspace binding.", {
      code: "WORKSPACE_VALIDATION_SESSION_MISMATCH",
    })
  }
  return {
    sessionId,
    turnId: validationIdentifier(input.turnId, "turnId"),
    revision: validationIdentifier(input.revision, "revision", 512),
  }
}

function validationKind(value: unknown): WorkspaceValidationKind {
  if (value === "test" || value === "typecheck" || value === "build" || value === "custom") return value
  throw new PixiuError(`Unknown validation kind: ${String(value ?? "")}`, {
    code: "WORKSPACE_VALIDATION_KIND_INVALID",
  })
}

function validationCommand(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PixiuError(`${label} must be a non-empty string.`, {
      code: "WORKSPACE_VALIDATION_COMMAND_INVALID",
    })
  }
  const command = value.trim()
  if (command.length > MAX_COMMAND_LENGTH || command.includes("\0")) {
    throw new PixiuError(`${label} is invalid or too long.`, {
      code: "WORKSPACE_VALIDATION_COMMAND_INVALID",
    })
  }
  return command
}

function validationIdentifier(value: unknown, label: string, maxLength = 200) {
  if (typeof value !== "string") throw invalidIdentifier(label)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\0\r\n]/.test(normalized)) throw invalidIdentifier(label)
  return normalized
}

function invalidIdentifier(label: string) {
  return new PixiuError(`Validation ${label} is invalid.`, {
    code: "WORKSPACE_VALIDATION_KEY_INVALID",
  })
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string) {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new PixiuError(`Validation ${label} must be an integer from ${minimum} to ${maximum}.`, {
      code: "WORKSPACE_VALIDATION_OPTION_INVALID",
    })
  }
  return resolved
}

async function readBoundedOutput(stream: ReadableStream<Uint8Array>, budget: { remaining: number; truncated: boolean }) {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    const length = Math.min(chunk.value.byteLength, budget.remaining)
    if (length > 0) {
      chunks.push(Buffer.from(chunk.value.subarray(0, length)))
      budget.remaining -= length
    }
    if (length < chunk.value.byteLength) budget.truncated = true
  }
  return Buffer.concat(chunks).toString("utf8")
}

function boundedRedactedOutput(value: string, maxBytes: number, alreadyTruncated: boolean) {
  const redacted = redactSecrets(value)
  const bytes = Buffer.from(redacted)
  if (!alreadyTruncated && bytes.byteLength <= maxBytes) return { text: redacted, truncated: false }
  const marker = Buffer.from(TRUNCATION_MARKER)
  if (marker.byteLength >= maxBytes) return { text: utf8Prefix(marker, maxBytes), truncated: true }
  const separator = "\n"
  const prefixBytes = Math.max(0, maxBytes - marker.byteLength - Buffer.byteLength(separator))
  const prefix = utf8Prefix(bytes, prefixBytes)
  return { text: `${prefix}${separator}${TRUNCATION_MARKER}`, truncated: true }
}

function utf8Prefix(value: Buffer, maxBytes: number) {
  let prefix = value.subarray(0, maxBytes).toString("utf8")
  while (Buffer.byteLength(prefix) > maxBytes) prefix = prefix.slice(0, -1)
  return prefix
}

function killValidationProcess(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals) {
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ESRCH") throw error
    }
  }
  try {
    child.kill(signal)
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") throw error
  }
}

async function requireSafeWorkRoot(binding: SessionWorkspaceBinding) {
  await requireSafeBindingRoot(binding)
  const info = await lstat(binding.workRoot).catch((cause) => {
    throw new PixiuError("Validation workspace is unavailable.", {
      code: "WORKSPACE_VALIDATION_ROOT_INVALID",
      cause,
    })
  })
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PixiuError("Validation workspace must be a real directory.", {
      code: "WORKSPACE_VALIDATION_ROOT_INVALID",
    })
  }
  const [root, workRoot] = await Promise.all([realpath(binding.root), realpath(binding.workRoot)])
  if (!isInside(root, workRoot) || workRoot !== resolve(binding.workRoot)) {
    throw new PixiuError("Validation workspace escapes its session binding.", {
      code: "WORKSPACE_VALIDATION_ROOT_INVALID",
    })
  }
}

async function requireSafeBindingRoot(binding: SessionWorkspaceBinding) {
  const info = await lstat(binding.root).catch((cause) => {
    throw new PixiuError("Validation binding root is unavailable.", {
      code: "WORKSPACE_VALIDATION_ROOT_INVALID",
      cause,
    })
  })
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(binding.root) !== resolve(binding.root)) {
    throw new PixiuError("Validation binding root must be a real directory.", {
      code: "WORKSPACE_VALIDATION_ROOT_INVALID",
    })
  }
}

async function requirePlainStoreHandle(handle: Awaited<ReturnType<typeof open>>) {
  const info = await handle.stat()
  if (!info.isFile() || info.nlink !== 1) throw invalidValidationStore()
}

function invalidValidationStore(cause?: unknown) {
  return new PixiuError("Workspace validation store must be a private plain file.", {
    code: "WORKSPACE_VALIDATION_STORE_INVALID",
    ...(cause === undefined ? {} : { cause }),
  })
}

function noFollowFlag() {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
}

function normalizeRecord(value: unknown): WorkspaceValidationRecord {
  if (!isRecord(value)) throw new Error("record must be an object")
  const kind = validationKind(value.kind)
  const status = value.status
  if (status !== "passed" && status !== "failed" && status !== "cancelled") throw new Error("invalid status")
  const startedAt = isoDate(value.startedAt)
  const completedAt = isoDate(value.completedAt)
  if (typeof value.durationMs !== "number" || !Number.isInteger(value.durationMs) || value.durationMs < 0) throw new Error("invalid duration")
  if (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode)) throw new Error("invalid exit code")
  if (typeof value.output !== "string" || typeof value.truncated !== "boolean" || typeof value.timedOut !== "boolean") {
    throw new Error("invalid validation output")
  }
  return {
    id: validationIdentifier(value.id, "id"),
    sessionId: validationIdentifier(value.sessionId, "sessionId"),
    turnId: validationIdentifier(value.turnId, "turnId"),
    revision: validationIdentifier(value.revision, "revision", 512),
    kind,
    command: validationCommand(value.command, "recorded validation command"),
    status,
    startedAt,
    completedAt,
    durationMs: value.durationMs,
    exitCode: value.exitCode,
    output: value.output,
    truncated: value.truncated,
    timedOut: value.timedOut,
  }
}

function isoDate(value: unknown) {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new Error("invalid timestamp")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

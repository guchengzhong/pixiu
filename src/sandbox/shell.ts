import { spawn } from "node:child_process"
import { delimiter, resolve } from "node:path"

import { truncateText } from "../shared/text"
import { isInside } from "./path"

export type ShellRunOptions = {
  cwd: string
  timeoutMs: number
  outputMaxBytes: number
  envAllowlist: string[]
  envPrependPath?: string[]
  envOverrides?: Record<string, string>
  signal?: AbortSignal
}

export type ShellRisk = {
  risk: "low" | "medium" | "high"
  category: "read" | "write" | "delete" | "network" | "package" | "git" | "unknown"
  reason: string
}

export type ShellRunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

const READ_COMMANDS = new Set(["cat", "ls", "pwd", "grep", "rg", "find", "sed", "head", "tail", "wc", "date", "uname", "printf", "echo"])
const DELETE_COMMANDS = /\b(rm|rmdir|unlink|shred)\b/
const WRITE_COMMANDS = /\b(touch|mkdir|tee|cp|mv|install)\b|(^|[^&])>{1,2}[^&]|\bsed\s+-i\b/
const NETWORK_COMMANDS = /\b(curl|wget|ssh|scp|rsync|nc|ncat|telnet|ftp|sftp|ping)\b/
const PACKAGE_COMMANDS = /\b(npm|pnpm|yarn|bun|pip|pip3|uv|cargo|go|apt|apt-get|brew|conda|mamba)\s+(install|add|remove|update|upgrade|publish|run|x|exec)\b/
const GIT_COMMANDS = /\bgit\s+(clone|pull|push|fetch|checkout|switch|reset|clean|merge|rebase|commit|tag|submodule)\b/

export function buildAllowedEnv(allowlist: string[], options: { prependPath?: string[]; overrides?: Record<string, string> } = {}) {
  const env: Record<string, string> = {}
  for (const key of allowlist) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    env[key] = value
  }
  if (env.PATH !== undefined && options.prependPath?.length) {
    const current = env.PATH.split(delimiter).filter(Boolean)
    const next = [...options.prependPath.filter(Boolean), ...current]
    env.PATH = [...new Set(next)].join(delimiter)
  }
  return env
}

export function classifyShellCommand(command: string): ShellRisk {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (DELETE_COMMANDS.test(normalized)) return { risk: "high", category: "delete", reason: "delete command" }
  if (PACKAGE_COMMANDS.test(normalized)) return { risk: "high", category: "package", reason: "package manager command" }
  if (NETWORK_COMMANDS.test(normalized)) return { risk: "high", category: "network", reason: "network command" }
  if (GIT_COMMANDS.test(normalized)) return { risk: "medium", category: "git", reason: "git repository command" }
  if (WRITE_COMMANDS.test(normalized)) return { risk: "high", category: "write", reason: "filesystem write command" }
  const first = normalized.match(/^(?:env\s+)?([A-Za-z0-9_.-]+)/)?.[1]
  if (first && READ_COMMANDS.has(first)) return { risk: "low", category: "read", reason: `read-only command: ${first}` }
  return { risk: "medium", category: "unknown", reason: "unclassified shell command" }
}

export function findOutsideWorkspaceShellWrite(command: string, workspaceRoot: string) {
  const targets = [...redirectionTargets(command), ...writeCommandTargets(command)]
  return targets.find((target) => {
    if (!target || target.startsWith("&")) return false
    const stripped = stripQuotes(target)
    if (stripped === "/dev/null") return false
    const absolute = resolve(workspaceRoot, stripped)
    return !isInside(workspaceRoot, absolute)
  })
}

export function runShell(command: string, options: ShellRunOptions) {
  return new Promise<ShellRunResult>((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: buildAllowedEnv(options.envAllowlist, {
        ...(options.envPrependPath ? { prependPath: options.envPrependPath } : {}),
        ...(options.envOverrides ? { overrides: options.envOverrides } : {}),
      }),
      // Close stdin so interactive commands (e.g. Windows `cmd.exe date`/`time`/`pause`)
      // receive EOF immediately instead of blocking until the timeout waiting for input.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, options.timeoutMs)
    const abort = () => killProcessTree(child)
    options.signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("close", (exitCode) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      const stdoutSummary = truncateText(stdout, options.outputMaxBytes)
      const stderrSummary = truncateText(stderr, options.outputMaxBytes)
      resolve({
        exitCode,
        stdout: stdoutSummary.text,
        stderr: stderrSummary.text,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutBytes: stdoutSummary.bytes,
        stderrBytes: stderrSummary.bytes,
        stdoutTruncated: stdoutSummary.truncated,
        stderrTruncated: stderrSummary.truncated,
      })
    })
  })
}

// Reliably terminate a shell child and its descendants. Windows `cmd.exe` does not
// forward SIGTERM to its children, so a plain child.kill leaves the tree running;
// taskkill /t /f kills the whole tree. On POSIX SIGKILL is enough for our use.
function killProcessTree(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true })
      return
    } catch {
      // fall through to best-effort kill
    }
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // process already gone
  }
}

function redirectionTargets(command: string) {
  return [...command.matchAll(/(?:^|\s)(?:\d?>{1,2}|&>)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)].map((match) => match[1] ?? "")
}

function writeCommandTargets(command: string) {
  const tokens = command.match(/"[^"]+"|'[^']+'|[^\s;&|]+/g) ?? []
  const targets: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripQuotes(tokens[index] ?? "")
    if (["touch", "mkdir", "tee", "rm", "rmdir", "unlink", "shred"].includes(token)) {
      const next = tokens[index + 1]
      if (next && !next.startsWith("-")) targets.push(next)
    }
    if (["cp", "mv", "install"].includes(token)) {
      const next = tokens[index + 2] ?? tokens[index + 1]
      if (next && !next.startsWith("-")) targets.push(next)
    }
  }
  return targets
}

function stripQuotes(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

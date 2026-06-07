import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { AgentEvent } from "../../src/agent/events"
import { createFakeLLMServer, type FakeLLMServer } from "./llm-server"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const CLI_ENTRY = join(REPO_ROOT, "src/cli/index.ts")
const BUN_BIN = process.execPath

type SpawnSignal = Parameters<ReturnType<typeof Bun.spawn>["kill"]>[0]

export type MinicodeProcessResult = {
  args: string[]
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  durationMs: number
}

export type MinicodeSpawnHandle = {
  args: string[]
  stdout: Promise<string>
  stderr: Promise<string>
  exited: Promise<number>
  kill(signal?: SpawnSignal): void
  close(): Promise<MinicodeProcessResult>
  result(): Promise<MinicodeProcessResult>
}

export type MinicodeSpawnOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  input?: string
}

export type MinicodeRunOptions = MinicodeSpawnOptions & {
  json?: boolean
  yes?: boolean
  sessionId?: string
}

export type MinicodeFixture = {
  rootDir: string
  homeDir: string
  projectDir: string
  llm: FakeLLMServer
  run(message: string, options?: MinicodeRunOptions): Promise<MinicodeProcessResult>
  exec(args: string[], options?: MinicodeSpawnOptions): Promise<MinicodeProcessResult>
  spawn(args: string[], options?: MinicodeSpawnOptions): MinicodeSpawnHandle
}

export async function withMinicodeFixture<T>(fn: (fixture: MinicodeFixture) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "minicode-harness-"))
  const homeDir = join(rootDir, "home")
  const projectDir = join(rootDir, "project")
  const tmpDir = join(rootDir, "tmp")
  const llm = await createFakeLLMServer()
  const handles = new Set<MinicodeSpawnHandle>()

  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await mkdir(tmpDir, { recursive: true })
  await mkdir(join(projectDir, ".minicode/skills"), { recursive: true })
  await writeTestConfig(projectDir, llm.url)

  const fixture: MinicodeFixture = {
    rootDir,
    homeDir,
    projectDir,
    llm,
    run(message, options = {}) {
      const args = [
        "run",
        ...(options.json ? ["--json"] : []),
        ...(options.yes ? ["--yes"] : []),
        ...(options.sessionId ? ["--session", options.sessionId] : []),
        message,
      ]
      return fixture.exec(args, options)
    },
    exec(args, options = {}) {
      return runProcess(args, {
        cwd: options.cwd ?? projectDir,
        env: testEnv({ rootDir, homeDir, tmpDir, ...(options.env !== undefined ? { extra: options.env } : {}) }),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.input !== undefined ? { input: options.input } : {}),
      })
    },
    spawn(args, options = {}) {
      const handle = createSpawnHandle(args, {
        cwd: options.cwd ?? projectDir,
        env: testEnv({ rootDir, homeDir, tmpDir, ...(options.env !== undefined ? { extra: options.env } : {}) }),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.input !== undefined ? { input: options.input } : {}),
      })
      handles.add(handle)
      handle.result().finally(() => handles.delete(handle))
      return handle
    },
  }

  try {
    return await fn(fixture)
  } finally {
    await Promise.all([...handles].map((handle) => handle.close().catch(() => undefined)))
    await llm.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}

export function parseJsonEvents<T = AgentEvent>(stdout: string): T[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as T
      } catch (cause) {
        throw new Error(`Invalid JSONL event on line ${index + 1}: ${line}`, { cause })
      }
    })
}

export function expectExit(result: MinicodeProcessResult, expected: number, label = result.args.join(" ")) {
  if (result.timedOut) {
    throw new Error(`${label} timed out after ${result.durationMs}ms\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  if (result.exitCode !== expected) {
    throw new Error(
      `${label} exited ${result.exitCode}, expected ${expected}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
}

async function runProcess(
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs?: number; input?: string },
): Promise<MinicodeProcessResult> {
  return createSpawnHandle(args, options).result()
}

function createSpawnHandle(
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs?: number; input?: string },
): MinicodeSpawnHandle {
  const startedAt = Date.now()
  const child = Bun.spawn({
    cmd: [BUN_BIN, "run", CLI_ENTRY, ...args],
    cwd: options.cwd,
    env: options.env,
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (options.input !== undefined) {
    if (!child.stdin) throw new Error("expected child stdin pipe")
    child.stdin.write(options.input)
    child.stdin.end()
  }
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()

  let timedOut = false
  let completed = false
  let hardKill: ReturnType<typeof setTimeout> | undefined
  const kill = (signal: SpawnSignal = "SIGTERM") => {
    if (completed) return
    child.kill(signal)
    hardKill ??= setTimeout(() => {
      if (!completed) child.kill("SIGKILL")
    }, 1_000)
  }
  const timeout = setTimeout(() => {
    timedOut = true
    kill()
  }, options.timeoutMs ?? 10_000)

  const result = (async (): Promise<MinicodeProcessResult> => {
    let exitCode = await child.exited
    completed = true
    if (timedOut) exitCode = -1
    clearTimeout(timeout)
    if (hardKill) clearTimeout(hardKill)

    return {
      args,
      stdout: await stdout,
      stderr: await stderr,
      exitCode,
      timedOut,
      durationMs: Date.now() - startedAt,
    }
  })()

  return {
    args,
    stdout,
    stderr,
    exited: result.then((item) => item.exitCode),
    kill,
    close() {
      kill()
      return result
    },
    result() {
      return result
    },
  }
}

function testEnv(options: { rootDir: string; homeDir: string; tmpDir: string; extra?: Record<string, string | undefined> }) {
  const env: Record<string, string> = {
    PATH: [join(REPO_ROOT, ".tools/bun/bin"), process.env.PATH ?? ""].filter(Boolean).join(":"),
    HOME: options.homeDir,
    XDG_CONFIG_HOME: join(options.homeDir, ".config"),
    XDG_DATA_HOME: join(options.homeDir, ".local/share"),
    XDG_STATE_HOME: join(options.homeDir, ".local/state"),
    XDG_CACHE_HOME: join(options.homeDir, ".cache"),
    TMPDIR: options.tmpDir,
    USER: "minicode-test",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    SHELL: process.env.SHELL ?? "/bin/sh",
    MINICODE_TEST_API_KEY: "test-key",
    MINICODE_TEST_SKILLHUB_KEY: "test-skillhub-key",
    MINICODE_TEST_ROOT: options.rootDir,
  }

  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

async function writeTestConfig(projectDir: string, baseURL: string) {
  const config = {
    model: "openai-compatible/test-model",
    providers: {
      "openai-compatible": {
        type: "openai-compatible",
        baseURL,
        apiKeyEnv: "MINICODE_TEST_API_KEY",
      },
    },
    agents: {
      default: {
        description: "Default test agent.",
        systemPrompt: "You are minicode under test. Follow the completion protocol exactly.",
        tools: ["read", "grep", "glob", "shell", "write", "edit", "patch", "todo", "skill"],
        maxSteps: 8,
      },
    },
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      shell: "ask",
      write: "ask",
      edit: "ask",
      patch: "ask",
    },
    skills: {
      paths: [".minicode/skills"],
    },
    skillhub: {
      baseURL: "http://127.0.0.1/unused",
      apiKeyEnv: "MINICODE_TEST_SKILLHUB_KEY",
      installDir: ".minicode/skills",
    },
    mcp: {},
    sandbox: {
      mode: "workspace",
      workspaceDir: "workspace",
      workspaceOnly: true,
      shellTimeoutMs: 5_000,
      outputMaxBytes: 8_000,
      envAllowlist: ["PATH", "HOME", "USER", "LANG", "LC_ALL", "SHELL", "TMPDIR"],
    },
    compaction: {
      maxApproxTokens: 64_000,
      keepRecentMessages: 12,
    },
  }
  await writeFile(join(projectDir, "minicode.jsonc"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

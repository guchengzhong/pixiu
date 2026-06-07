import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import type { AgentEvent } from "../../src/agent/events"
import type { JsonValue } from "../../src/shared/json"
import type { FakeLLMServer, Hit, Match, Usage } from "./llm-server"
import { parseJsonEvents, type MinicodeProcessResult, type MinicodeRunOptions, withMinicodeFixture } from "./minicode-process"

type ScenarioStep = (llm: FakeLLMServer) => void

type Matcher = string | RegExp | ((value: string) => boolean)

export type Scenario = {
  name: string
  prompt: string
  replies: ScenarioStep[]
  run?: MinicodeRunOptions
  expect?: {
    exitCode?: number
    timedOut?: boolean
    stdoutContains?: Matcher[]
    stdoutNotContains?: Matcher[]
    stderrContains?: Matcher[]
    stderr?: string
    eventTypes?: string[]
    workspaceFiles?: Record<string, Matcher>
    workspaceMissing?: string[]
    llmRequests?: {
      count?: number
      contains?: Matcher[]
      toolsInclude?: string[]
    }
  }
}

export type ScenarioResult = {
  result: MinicodeProcessResult
  events: AgentEvent[]
  hits: Hit[]
  sessionId?: string
}

export function text(value: string, options?: { match?: Match; reasoning?: string; usage?: Usage; delayMs?: number }) {
  return (llm: FakeLLMServer) => llm.text(value, options)
}

export function tool(
  name: string,
  input: unknown,
  options?: { match?: Match; id?: string; splitArgs?: boolean; reasoning?: string; usage?: Usage; delayMs?: number },
) {
  return (llm: FakeLLMServer) => llm.tool(name, input, options)
}

export function httpError(status: number, body: unknown, options?: { match?: Match }) {
  return (llm: FakeLLMServer) => llm.error(status, body, options)
}

export function streamError(message?: string, options?: { match?: Match; delayMs?: number }) {
  return (llm: FakeLLMServer) => llm.streamError(message, options)
}

export function hang(options?: { match?: Match; delayMs?: number }) {
  return (llm: FakeLLMServer) => llm.hang(options)
}

export function reset(options?: { match?: Match; delayMs?: number }) {
  return (llm: FakeLLMServer) => llm.reset(options)
}

export function raw(
  chunks: Array<unknown | { raw: string }>,
  options?: { match?: Match; done?: boolean; hang?: boolean; reset?: boolean; delayMs?: number },
) {
  return (llm: FakeLLMServer) => llm.raw(chunks, options)
}

export function requestBodyIncludes(value: string): Match {
  return (hit) => JSON.stringify(hit.body).includes(value)
}

export function requestHasToolResult(name?: string): Match {
  return (hit) => {
    const messages = Array.isArray(hit.body.messages) ? hit.body.messages : []
    return messages.some((message) => {
      if (!message || typeof message !== "object") return false
      const raw = message as Record<string, unknown>
      if (raw.role !== "tool") return false
      if (!name) return true
      return String(raw.content ?? "").includes(name)
    })
  }
}

export async function runScenario(input: Scenario): Promise<ScenarioResult> {
  return withMinicodeFixture(async (fixture) => {
    let result: MinicodeProcessResult | undefined
    let events: AgentEvent[] = []
    try {
      for (const reply of input.replies) reply(fixture.llm)
      result = await fixture.run(input.prompt, input.run)
      events = maybeParseEvents(result.stdout)
      const sessionId = sessionIdFromEvents(events) ?? (await singleWorkspaceSessionId(fixture.projectDir))
      await assertScenario(input, {
        result,
        events,
        hits: fixture.llm.hits,
        projectDir: fixture.projectDir,
        ...(sessionId ? { sessionId } : {}),
      })
      return { result, events, hits: fixture.llm.hits, ...(sessionId ? { sessionId } : {}) }
    } catch (cause) {
      const artifactDir = await writeEvidence(input.name, {
        projectDir: fixture.projectDir,
        events,
        hits: fixture.llm.hits,
        ...(result ? { result } : {}),
      })
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`[scenario:${input.name}] ${message}\nEvidence: ${artifactDir}`)
    }
  })
}

async function assertScenario(
  input: Scenario,
  context: {
    result: MinicodeProcessResult
    events: AgentEvent[]
    hits: Hit[]
    projectDir: string
    sessionId?: string
  },
) {
  const expected = input.expect ?? {}
  if (expected.exitCode !== undefined) {
    assert(context.result.exitCode === expected.exitCode, `exitCode expected ${expected.exitCode}, got ${context.result.exitCode}`)
  }
  if (expected.timedOut !== undefined) {
    assert(context.result.timedOut === expected.timedOut, `timedOut expected ${expected.timedOut}, got ${context.result.timedOut}`)
  }
  for (const matcher of expected.stdoutContains ?? []) {
    assert(matches(context.result.stdout, matcher), `stdout did not contain ${describeMatcher(matcher)}`)
  }
  for (const matcher of expected.stdoutNotContains ?? []) {
    assert(!matches(context.result.stdout, matcher), `stdout unexpectedly contained ${describeMatcher(matcher)}`)
  }
  for (const matcher of expected.stderrContains ?? []) {
    assert(matches(context.result.stderr, matcher), `stderr did not contain ${describeMatcher(matcher)}`)
  }
  if (expected.stderr !== undefined) {
    assert(context.result.stderr === expected.stderr, `stderr expected ${JSON.stringify(expected.stderr)}, got ${JSON.stringify(context.result.stderr)}`)
  }
  if (expected.eventTypes) {
    assertEqual(context.events.map((event) => event.type), expected.eventTypes, "event types")
  }

  if (expected.workspaceFiles || expected.workspaceMissing) {
    const sessionId = context.sessionId
    assert(sessionId !== undefined, "workspace assertions need a session id")
    const root = join(context.projectDir, "workspace", sessionId)
    for (const [path, matcher] of Object.entries(expected.workspaceFiles ?? {})) {
      const content = await readFile(join(root, path), "utf8")
      assert(matches(content, matcher), `workspace file ${path} did not match ${describeMatcher(matcher)}`)
    }
    for (const path of expected.workspaceMissing ?? []) {
      assert(!(await exists(join(root, path))), `workspace file ${path} unexpectedly exists`)
    }
  }

  const request = expected.llmRequests
  if (request) {
    if (request.count !== undefined) assert(context.hits.length === request.count, `LLM requests expected ${request.count}, got ${context.hits.length}`)
    const bodyText = context.hits.map((hit) => JSON.stringify(hit.body)).join("\n")
    for (const matcher of request.contains ?? []) {
      assert(matches(bodyText, matcher), `LLM request bodies did not contain ${describeMatcher(matcher)}`)
    }
    const tools = new Set(context.hits.flatMap((hit) => requestToolNames(hit.body)))
    for (const name of request.toolsInclude ?? []) {
      assert(tools.has(name), `LLM request tools did not include ${name}`)
    }
  }
}

function maybeParseEvents(stdout: string) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length || !lines.every((line) => line.trim().startsWith("{"))) return []
  return parseJsonEvents(stdout)
}

function sessionIdFromEvents(events: AgentEvent[]) {
  const event = events.find((item) => item.type === "session_created")
  return event?.type === "session_created" ? event.sessionId : undefined
}

async function singleWorkspaceSessionId(projectDir: string) {
  const workspace = join(projectDir, "workspace")
  try {
    const entries = await readdir(workspace, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    return dirs.length === 1 ? dirs[0] : undefined
  } catch {
    return undefined
  }
}

function requestToolNames(body: Record<string, unknown>) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return undefined
      const raw = tool as Record<string, unknown>
      const fn = raw.function && typeof raw.function === "object" ? (raw.function as Record<string, unknown>) : undefined
      return typeof fn?.name === "string" ? fn.name : undefined
    })
    .filter((name): name is string => Boolean(name))
}

function matches(value: string, matcher: Matcher) {
  if (typeof matcher === "string") return value.includes(matcher)
  if (matcher instanceof RegExp) return matcher.test(value)
  return matcher(value)
}

function describeMatcher(matcher: Matcher) {
  if (typeof matcher === "string") return JSON.stringify(matcher)
  if (matcher instanceof RegExp) return String(matcher)
  return "[function matcher]"
}

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message)
}

function assertEqual(actual: string[], expected: string[], label: string) {
  if (actual.length === expected.length && actual.every((value, index) => value === expected[index])) return
  throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeEvidence(
  name: string,
  input: {
    projectDir: string
    result?: MinicodeProcessResult
    events: AgentEvent[]
    hits: Hit[]
  },
) {
  const dir = await makeEvidenceDir(name)
  await writeFile(join(dir, "stdout.txt"), input.result?.stdout ?? "", "utf8")
  await writeFile(join(dir, "stderr.txt"), input.result?.stderr ?? "", "utf8")
  await writeFile(join(dir, "events.json"), JSON.stringify(input.events, null, 2), "utf8")
  await writeFile(join(dir, "llm-hits.json"), JSON.stringify(redactJson(input.hits), null, 2), "utf8")
  await writeFile(join(dir, "workspace-tree.txt"), (await tree(join(input.projectDir, "workspace"))).join("\n"), "utf8")
  await writeFile(join(dir, "sessions-tree.txt"), (await tree(join(input.projectDir, ".minicode/state/sessions"))).join("\n"), "utf8")
  await copyTextTree(join(input.projectDir, "workspace"), join(dir, "workspace"))
  await copyTextTree(join(input.projectDir, ".minicode/state/sessions"), join(dir, "sessions"))
  return dir
}

async function makeEvidenceDir(name: string) {
  const safe = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "scenario"
  const dir = join(tmpdir(), `minicode-scenario-${safe}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function tree(root: string) {
  const rows: string[] = []
  await walk(root, rows, root)
  return rows
}

async function walk(path: string, rows: string[], root: string) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(path, entry.name)
    rows.push(relative(root, absolute))
    if (entry.isDirectory()) await walk(absolute, rows, root)
  }
}

async function copyTextTree(sourceRoot: string, targetRoot: string) {
  await copyTextTreeInner(sourceRoot, targetRoot, sourceRoot)
}

async function copyTextTreeInner(path: string, targetRoot: string, sourceRoot: string) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const source = join(path, entry.name)
    const target = join(targetRoot, relative(sourceRoot, source))
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true })
      await copyTextTreeInner(source, targetRoot, sourceRoot)
      continue
    }
    if (!entry.isFile()) continue
    await mkdir(dirname(target), { recursive: true })
    const buffer = await readFile(source)
    await writeFile(target, evidenceFileContent(buffer), "utf8")
  }
}

function evidenceFileContent(buffer: Buffer) {
  if (!isProbablyText(buffer)) return `<binary file: ${buffer.byteLength} bytes>\n`
  const maxBytes = 200_000
  const text = buffer.toString("utf8", 0, Math.min(buffer.byteLength, maxBytes))
  const suffix = buffer.byteLength > maxBytes ? `\n<truncated: ${buffer.byteLength - maxBytes} bytes omitted>\n` : ""
  return redactText(text) + suffix
}

function isProbablyText(buffer: Buffer) {
  if (buffer.includes(0)) return false
  const sample = buffer.subarray(0, Math.min(buffer.length, 4_000))
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte >= 32) continue
    suspicious += 1
  }
  return suspicious / Math.max(sample.length, 1) < 0.05
}

function redactJson(value: JsonValue | unknown): unknown {
  if (typeof value === "string") {
    return redactText(value)
  }
  if (Array.isArray(value)) return value.map(redactJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]))
  }
  return value
}

function redactText(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]")
    .replace(
      /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|ACCESS[_-]?KEY)[A-Z0-9_]*=)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[redacted]",
    )
    .replace(/([?&](?:api[_-]?key|key|token|secret|password|access[_-]?key)=)[^&\s"']+/gi, "$1[redacted]")
}

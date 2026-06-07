import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { AgentEvent } from "../src/agent/events"
import type { MinicodeConfig } from "../src/config/defaults"
import { loadConfig, resolveProviderConfig } from "../src/config/loader"
import { buildRuntime } from "../src/runtime/build"
import type { Runtime } from "../src/runtime/build"
import { formatError, MinicodeError } from "../src/shared/errors"
import { redactSecrets } from "../src/shared/redact"

type SmokeCase = {
  name: string
  prompt: string
  verify(input: { runtime: Runtime; events: AgentEvent[]; sessionId?: string }): Promise<{ files?: string[] }>
}

export type LiveSmokeCaseResult = {
  name: string
  ok: boolean
  sessionId?: string
  toolCalls: string[]
  producedFiles: string[]
  finalMessage?: string
  failureReason?: string
}

export type LiveSmokeReport = {
  ok: boolean
  provider: {
    baseURL?: string
    model: string
    apiKeyEnv?: string
  }
  cwd: string
  reportPath: string
  cases: LiveSmokeCaseResult[]
}

export type LiveSmokeOptions = {
  cwd?: string
  reportPath?: string
  timeoutMs?: number
}

const TOOL_FILE = "live-smoke-tool.md"
const TEMP_EVIDENCE_FILE = ".minicode/tmp/live-smoke-evidence.md"

export async function runLiveSmoke(options: LiveSmokeOptions = {}): Promise<LiveSmokeReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const config = await loadConfig({ cwd })
  const provider = resolveProviderConfig(config)
  const apiKeyEnv = provider.apiKeyEnv
  if (!provider.apiKey) {
    throw new MinicodeError(
      `Live smoke requires a provider API key. Set ${apiKeyEnv ?? "the configured provider apiKeyEnv"} before running smoke:live.`,
      { code: "LIVE_SMOKE_API_KEY_MISSING" },
    )
  }

  const cases: LiveSmokeCaseResult[] = []
  for (const item of smokeCases()) {
    cases.push(await runCase({ cwd, config, item, timeoutMs: options.timeoutMs ?? 120_000 }))
  }

  const report: LiveSmokeReport = {
    ok: cases.every((item) => item.ok),
    provider: {
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      model: provider.model ?? config.model,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    },
    cwd,
    reportPath: resolve(cwd, options.reportPath ?? "docs/updates/260605_live_smoke/report.md"),
    cases,
  }
  await writeReport(report)
  return report
}

function smokeCases(): SmokeCase[] {
  return [
    {
      name: "plain-text",
      prompt: "Live smoke: please answer with exactly `FINAL: plain text smoke ok`. Do not call tools.",
      async verify({ events }) {
        const final = finalMessage(events)
        if (!final) throw new Error("missing final assistant message")
        return {}
      },
    },
    {
      name: "tool-call",
      prompt: [
        "Live smoke: use the write tool to create `live-smoke-tool.md` in the workspace.",
        "The file content must include `Live smoke tool-call smoke`.",
        "After writing it, answer with FINAL: and summarize the file.",
      ].join(" "),
      async verify({ runtime, sessionId }) {
        if (!sessionId) throw new Error("missing session id")
        const content = await readSessionFile(runtime, sessionId, TOOL_FILE)
        if (!content.includes("Live smoke tool-call smoke")) throw new Error(`${TOOL_FILE} did not contain expected marker`)
        return { files: [TOOL_FILE] }
      },
    },
    {
      name: "temporary-script",
      prompt: [
        "Live smoke: you must call the shell tool.",
        `Create \`${TEMP_EVIDENCE_FILE}\` under the workspace using shell or a temporary script.`,
        "The file must contain lines beginning with `Command:`, `Source:`, and `Access time:`.",
        "Do not access the public internet for this smoke; use a local shell command/source.",
        "After the file exists, answer with FINAL: and mention the evidence file.",
      ].join(" "),
      async verify({ runtime, events, sessionId }) {
        if (!sessionId) throw new Error("missing session id")
        if (!toolCalls(events).includes("shell")) throw new Error("temporary-script case did not call shell")
        const content = await readSessionFile(runtime, sessionId, TEMP_EVIDENCE_FILE)
        for (const marker of ["Command:", "Source:", "Access time:"]) {
          if (!content.includes(marker)) throw new Error(`${TEMP_EVIDENCE_FILE} missing ${marker}`)
        }
        return { files: [TEMP_EVIDENCE_FILE] }
      },
    },
  ]
}

async function runCase(input: { cwd: string; config: MinicodeConfig; item: SmokeCase; timeoutMs: number }): Promise<LiveSmokeCaseResult> {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, input.timeoutMs)
  try {
    const runtime = (await buildRuntime({ cwd: input.cwd, config: input.config, yes: true, signal: controller.signal })) as Runtime
    const item = input.item
    for await (const event of runtime.runner.run({ message: item.prompt, title: `live smoke: ${item.name}` })) events.push(event)
    const errors = events.filter((event) => event.type === "error").map((event) => event.message)
    const sessionId = sessionIdFrom(events)
    const verification = errors.length || timedOut ? { files: [] } : await item.verify({ runtime, events, ...(sessionId ? { sessionId } : {}) })
    const ok = errors.length === 0 && !timedOut
    const final = finalMessage(events)
    return {
      name: item.name,
      ok,
      ...(sessionId ? { sessionId } : {}),
      toolCalls: toolCalls(events),
      producedFiles: verification.files ?? [],
      ...(final ? { finalMessage: final } : {}),
      ...(timedOut ? { failureReason: `timed out after ${input.timeoutMs} ms` } : errors.length ? { failureReason: errors.join("; ") } : {}),
    }
  } catch (error) {
    const sessionId = sessionIdFrom(events)
    const final = finalMessage(events)
    return {
      name: input.item.name,
      ok: false,
      ...(sessionId ? { sessionId } : {}),
      toolCalls: toolCalls(events),
      producedFiles: [],
      ...(final ? { finalMessage: final } : {}),
      failureReason: timedOut ? `timed out after ${input.timeoutMs} ms` : formatError(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function readSessionFile(runtime: Runtime, sessionId: string, path: string) {
  const session = await runtime.sessions.getSession(sessionId)
  if (!session?.cwd) throw new Error(`missing workspace for session ${sessionId}`)
  return readFile(join(session.cwd, path), "utf8")
}

function sessionIdFrom(events: AgentEvent[]) {
  const event = events.find((item) => item.type === "session_created")
  return event?.type === "session_created" ? event.sessionId : undefined
}

function toolCalls(events: AgentEvent[]) {
  return events.filter((event) => event.type === "tool_call").map((event) => event.name)
}

function finalMessage(events: AgentEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === "message") return event.content
  }
  return undefined
}

async function writeReport(report: LiveSmokeReport) {
  await mkdir(dirname(report.reportPath), { recursive: true })
  await writeFile(report.reportPath, renderReport(report), "utf8")
}

export function renderReport(report: LiveSmokeReport) {
  return [
    "# minicode Live Smoke Report",
    "",
    `Status: ${report.ok ? "PASS" : "FAIL"}`,
    `Provider: ${safe(report.provider.baseURL ?? "(default)")}`,
    `Model: ${safe(report.provider.model)}`,
    `API key env: ${safe(report.provider.apiKeyEnv ?? "(inline config)")}`,
    `Project: ${safe(report.cwd)}`,
    "",
    "## Cases",
    "",
    ...report.cases.flatMap((item) => [
      `### ${item.name}`,
      "",
      `Status: ${item.ok ? "PASS" : "FAIL"}`,
      `Session: ${safe(item.sessionId ?? "(none)")}`,
      `Tool calls: ${safe(item.toolCalls.length ? item.toolCalls.join(", ") : "(none)")}`,
      `Produced files: ${safe(item.producedFiles.length ? item.producedFiles.join(", ") : "(none)")}`,
      item.finalMessage ? `Final message: ${safe(oneLine(item.finalMessage, 240))}` : "Final message: (none)",
      item.failureReason ? `Failure: ${safe(oneLine(item.failureReason, 400))}` : undefined,
      "",
    ]),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function safe(value: string) {
  return redactSecrets(value)
}

function oneLine(value: string, maxChars: number) {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

function isMain() {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(entry).href : false
}

if (isMain()) {
  try {
    const report = await runLiveSmoke(
      process.env.MINICODE_LIVE_SMOKE_REPORT ? { reportPath: process.env.MINICODE_LIVE_SMOKE_REPORT } : {},
    )
    console.log(renderReport(report))
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    console.error(formatError(error))
    process.exitCode = 1
  }
}

#!/usr/bin/env bun
import { access, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createInterface } from "node:readline/promises"

import { buildRuntime, type Runtime, type RuntimeWithoutLLM } from "../runtime/build"
import { logger } from "../runtime/logger"
import { formatError, MinicodeError } from "../shared/errors"
import { loadConfig, validateConfig } from "../config/loader"
import { defaultConfig, type MinicodeConfig } from "../config/defaults"
import { readJsoncFile } from "../shared/json"
import { SkillHubProvider, installRemoteSkill, planSkillInstall } from "../skillhub/provider"
import type { SkillInstallPlan, SkillInstallResult } from "../skillhub/types"
import { createMCPClient, inspectMCPServers } from "../mcp/status"
import { mcpToolsToDefinitions } from "../mcp/tools"
import { CliTraceRenderer } from "./trace"
import { createTerminal, displayWidth, divider, oneLine, panel, panelWidthForTerminal, renderMarkdown, stripAnsi, table } from "./terminal"
import type { AgentEvent } from "../agent/events"
import { approximateTokens } from "../agent/compaction"
import type { JsonObject } from "../shared/json"
import type { PermissionDecision, PermissionMode, PermissionRequest } from "../permission/types"

const VERSION = "0.0.0"
const CHAT_CTRL_C = "__MINICODE_CTRL_C__"

type ChatInput = {
  isTTY: boolean
  echoesUserInput: boolean
  writesPrompt: boolean
  question(prompt: string): Promise<string | undefined>
  prompt(): void
  interrupt(): void
  suspend?(): void
  resume?(): void
  close(): void
}

const HELP = `minicode ${VERSION}

Usage:
  minicode --help
  minicode --version
  minicode doctor [--json]
  minicode run [options] <message>
  minicode -p [options] <message>
  minicode chat [options]

Agent commands:
  minicode run [--output-format text|json|stream-json] <message>
  minicode run [-c|--continue] <message>
  minicode run [--session <session-id>] <message>
  minicode run [--permission-mode default|acceptEdits|bypassPermissions|plan] <message>
  minicode -p [--output-format text|json|stream-json] <message>
  minicode chat [--permission-mode default|acceptEdits|bypassPermissions|plan]

Inspect:
  minicode tool list
  minicode session list
  minicode session resume
  minicode session show <session-id>

Config:
  minicode config validate
  minicode config show
  minicode config setup
  minicode config use <baseURL|alias> <apiKey> [model]
  minicode config use-env <baseURL|alias> <ENV_VAR> [model]
  minicode config list
  minicode config get <key>
  minicode config set <key> <json-value-or-string>

Skills:
  minicode skill init <name> [--description <text>] [--path <skills-dir>] [--yes] [--json]
  minicode skill list
  minicode skill show <name>
  minicode skill search [--remote] <query>
  minicode skill path list [--json]
  minicode skill path add <path> [--json]
  minicode skill path remove <path> [--json]
  minicode skill doctor [--json]
  minicode skill install <remote-skill-id> [--yes] [--json]

MCP:
  minicode mcp add stdio <name> [--timeout-ms <ms>] [--env <K=V>...] [--yes] [--json] -- <command> [args...]
  minicode mcp add http <name> <url> [--timeout-ms <ms>] [--header <K=V>...] [--yes] [--json]
  minicode mcp list [--json]
  minicode mcp test <name> [--json]
  minicode mcp doctor [--json]
  minicode mcp enable <name> [--json]
  minicode mcp disable <name> [--json]
  minicode mcp remove <name> [--json]

Common options:
  -p, --print                 Run once and print the answer.
  -c, --continue              Continue the latest session.
  --session <session-id>      Continue a specific session.
  --output-format <format>    text, json, or stream-json.
  --permission-mode <mode>    default, acceptEdits, bypassPermissions, or plan.
  --yes                       Alias for --permission-mode bypassPermissions.
  --verbose                   Show successful tool output previews.
  --no-color                  Disable ANSI color.

Examples:
  minicode -p "explain this repo"
  minicode run --permission-mode acceptEdits "format docs"
  minicode run --output-format stream-json "summarize recent changes"
  minicode config use https://api.example.com/v1 sk-... openai-compatible/model
  minicode config use-env siliconflow MINICODE_API_KEY deepseek-ai/DeepSeek-V3.2
  minicode config set sandbox.shellTimeoutMs 30000

This is a compact agent framework: LLM stream, core tools, permissions, sessions, MCP, skills, and sandbox.
`

type CliResult = {
  exitCode: number
  output?: string
  error?: string
}

type ChatStats = {
  sessionId?: string
  model: string
  startedAt: number
  apiStartedAt?: number
  apiMs: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
}

type CliOptions = {
  stream?: boolean
  stdout?: Pick<typeof process.stdout, "write"> & { isTTY?: boolean }
}

type OutputFormat = "text" | "json" | "stream-json" | "jsonl-legacy"

type ProviderConfigResult = {
  baseURL: string
  model: string
  credential: "apiKey" | "apiKeyEnv"
  apiKeyEnv?: string
}

const PROVIDER_ENDPOINT_ALIASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  sf: "https://api.siliconflow.cn/v1",
  deepseek: "https://api.deepseek.com/v1",
}

function writeStream(options: CliOptions, text: string) {
  ;(options.stdout ?? process.stdout).write(text)
}

function has(args: string[], ...flags: string[]) {
  return args.some((arg) => flags.includes(arg))
}

function stripFlags(args: string[], flags: string[]) {
  const flagSet = new Set(flags)
  const valueFlags = new Set(["--output-format", "--session", "--permission-mode"])
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (flagSet.has(arg)) {
      if (valueFlags.has(arg)) index += 1
      continue
    }
    if ([...flagSet].some((flag) => arg.startsWith(`${flag}=`))) continue
    result.push(arg)
  }
  return result
}

function takeFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag)
  const equals = args.find((arg) => arg.startsWith(`${flag}=`))
  if (equals) {
    return {
      value: equals.slice(flag.length + 1),
      args: args.filter((arg) => arg !== equals),
    }
  }
  if (index === -1) return { value: undefined as string | undefined, args }
  return {
    value: args[index + 1],
    args: args.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1),
  }
}

function takeFlagValues(args: string[], flag: string) {
  const values: string[] = []
  const remaining: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === flag) {
      const value = args[index + 1]
      if (value === undefined) throw new MinicodeError(`${flag} requires a value`, { code: "CLI_USAGE" })
      values.push(value)
      index += 1
      continue
    }
    if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1))
      continue
    }
    remaining.push(arg)
  }
  return { values, args: remaining }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rejectRemovedFlags(args: string[]) {
  if (has(args, "--mock")) {
    throw new MinicodeError("--mock has been removed. Configure a real provider API key before running the agent.", {
      code: "CLI_USAGE",
    })
  }
}

function permissionModeFromArgs(args: string[]): PermissionMode {
  const flag = takeFlagValue(args, "--permission-mode")
  const explicit = parsePermissionMode(flag.value, args.includes("--permission-mode") || args.some((arg) => arg.startsWith("--permission-mode=")))
  if (has(args, "--yes")) return "bypassPermissions"
  return explicit ?? "default"
}

function parsePermissionMode(value: string | undefined, specified: boolean): PermissionMode | undefined {
  if (!specified) return undefined
  if (value === "default" || value === "acceptEdits" || value === "bypassPermissions" || value === "plan") return value
  throw new MinicodeError(`Invalid permission mode: ${value ?? ""}`, { code: "CLI_USAGE" })
}

function toJSONL(values: unknown[]) {
  return values.map((value) => JSON.stringify(value)).join("\n")
}

async function doctor(args: string[] = []): Promise<CliResult> {
  const json = has(args, "--json")
  const runtime = await buildRuntime({ loadLLM: false })
  const config = runtime.config
  const provider = config.providers["openai-compatible"]
  const providerEnv = provider?.apiKeyEnv
  const providerKeyPresent = provider?.apiKey || (providerEnv ? process.env[providerEnv] : undefined)
  const providerDetail = provider?.apiKey
    ? "apiKey configured"
    : providerEnv
      ? `${providerEnv} ${providerKeyPresent ? "is set" : "is not set"}`
      : "apiKeyEnv not configured"
  const skillDiagnostics = await runtime.skills.diagnostics()
  const mcpStatuses = await inspectMCPServers(config)
  const checks = [
    ["config", "ok", "minicode.jsonc loaded"],
    ["bun", "ok", `bun ${Bun.version}`],
    ["model", "ok", config.model],
    ["provider", providerKeyPresent ? "ok" : "warn", providerDetail],
    ["sessions", "ok", ".minicode/state/sessions"],
    ["workspace", "ok", `${config.sandbox.mode} (${config.sandbox.workspaceDir})`],
    ["skills", skillDiagnostics.length ? "warn" : "ok", `${runtime.config.skills.paths.length} paths, ${skillDiagnostics.length} diagnostics`],
    ["mcp", mcpStatuses.some((server) => server.status === "failed") ? "warn" : "ok", `${mcpStatuses.length} configured`],
  ]
  if (json) return { exitCode: 0, output: JSON.stringify({ checks: checks.map(([check, status, detail]) => ({ check, status, detail })) }, null, 2) }
  return {
    exitCode: 0,
    output: ["minicode doctor", table([["check", "status", "detail"], ...checks], { header: true })].join("\n"),
  }
}

async function runCommand(args: string[], options: CliOptions = {}): Promise<CliResult> {
  rejectRemovedFlags(args)
  const noColor = has(args, "--no-color")
  const verbose = has(args, "--verbose")
  const outputFlag = takeFlagValue(args, "--output-format")
  const outputFormat = parseOutputFormat(outputFlag.value, has(args, "--json"))
  const session = takeFlagValue(args, "--session")
  const permissionMode = permissionModeFromArgs(args)
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once("SIGINT", abort)
  const runtime = await buildRuntime({
    yes: permissionMode === "bypassPermissions",
    permissionMode,
    signal: controller.signal,
  })
  const continueLatest = has(args, "-c", "--continue")
  const resumeSessionId = session.value ?? (continueLatest ? (await latestSessionId(runtime)) : undefined)
  const message = stripFlags(session.args, ["--json", "--yes", "--verbose", "--no-color", "--output-format", "--permission-mode", "-p", "--print", "-c", "--continue"]).join(" ").trim()
  if (!message) throw new MinicodeError("run requires a message", { code: "CLI_USAGE" })

  const events: AgentEvent[] = []
  let text = ""
  let rendered = ""
  let sessionId = resumeSessionId
  const startedAt = Date.now()
  let finishReason = ""
  let errorMessage = ""
  let streamInitWritten = false
  const terminal = createTerminal({
    ...(options.stdout ? { stdout: options.stdout } : {}),
    noColor,
    accentColor: runtime.config.ui.accentColor,
  })
  const trace = outputFormat !== "text"
    ? undefined
    : new CliTraceRenderer({
        write(chunk) {
          rendered += chunk
          if (options.stream) writeStream(options, chunk)
        },
        noColor,
        verbose,
        terminal,
      })
  try {
    for await (const event of runtime.runner.run(resumeSessionId ? { message, sessionId: resumeSessionId } : { message })) {
      events.push(event)
      if (event.type === "session_created") {
        sessionId = event.sessionId
        if (options.stream && outputFormat === "stream-json" && !streamInitWritten) {
          writeStream(options, `${JSON.stringify(streamInitEvent(runtime, {
            sessionId,
            permissionMode,
            outputStyle: "default",
          }))}\n`)
          streamInitWritten = true
        }
      }
      if (event.type === "finish") finishReason = event.reason
      if (event.type === "error") errorMessage = event.message
      if (options.stream && outputFormat === "jsonl-legacy") writeStream(options, `${JSON.stringify(event)}\n`)
      if (options.stream && outputFormat === "stream-json") {
        const streamEvent = toStreamJsonEvent(event, sessionId)
        if (streamEvent) writeStream(options, `${JSON.stringify(streamEvent)}\n`)
      }
      trace?.handle(event)
      if (event.type === "llm_text_delta") {
        text += event.text
      }
    }
  } finally {
    process.off("SIGINT", abort)
    await runtime.close()
  }
  trace?.finish()
  const resultEvent = resultSummaryEvent(events, {
    ...(sessionId ? { sessionId } : {}),
    durationMs: Date.now() - startedAt,
    finishReason,
    errorMessage,
  })
  const exitCode = exitCodeForResult(resultEvent)
  if (options.stream && outputFormat === "json") writeStream(options, `${JSON.stringify([...events, resultEvent], null, 2)}\n`)
  if (options.stream && outputFormat === "stream-json") writeStream(options, `${JSON.stringify(resultEvent)}\n`)
  if (options.stream) {
    return { exitCode }
  }
  if (outputFormat === "jsonl-legacy") return { exitCode, output: toJSONL(events) }
  if (outputFormat === "stream-json") {
    return {
      exitCode,
      output: [
        JSON.stringify(streamInitEvent(runtime, {
          ...(sessionId ? { sessionId } : {}),
          permissionMode,
          outputStyle: "default",
        })),
        ...events.flatMap((event) => {
          const streamEvent = toStreamJsonEvent(event, sessionId)
          return streamEvent ? [JSON.stringify(streamEvent)] : []
        }),
        JSON.stringify(resultEvent),
      ].join("\n"),
    }
  }
  if (outputFormat === "json") return { exitCode, output: JSON.stringify([...events, resultEvent], null, 2) }
  const humanText = rendered.trimEnd() || text
  return {
    exitCode,
    output: humanText ? renderMarkdown(humanText, { terminal }) : events.map((event) => JSON.stringify(event)).join("\n"),
  }
}

async function chatCommand(args: string[]): Promise<CliResult> {
  rejectRemovedFlags(args)
  const noColor = has(args, "--no-color")
  const verbose = has(args, "--verbose")
  const permissionMode = permissionModeFromArgs(args)
  let config = await loadConfig()
  const terminal = createTerminal({ noColor, accentColor: config.ui.accentColor })
  const input = await createChatInput()
  let activeStatus: ReturnType<typeof createChatRunStatus> | undefined
  const permissionAsk = createCliPermissionAsk(input, terminal, {
    beforePrompt() {
      activeStatus?.pause()
    },
    afterPrompt() {
      activeStatus?.resume()
    },
  })
  let runtime = await buildChatRuntime(config, permissionMode, permissionAsk)
  const reloadRuntime = async () => {
    await runtime.close()
    config = await loadConfig()
    runtime = await buildChatRuntime(config, permissionMode, permissionAsk)
  }
  const sessionFlag = takeFlagValue(args, "--session")
  let activeSessionId = sessionFlag.value ?? (has(args, "-c", "--continue") ? await latestSessionId(runtime) : undefined)
  if (process.stdout.isTTY) clearTerminalForChat()
  process.stdout.write(`${await renderChatBanner(runtime, terminal, permissionMode, activeSessionId)}\n\n`)
  let output = ""
  let interruptArmed = false
  let exitRequested = false
  let activeController: AbortController | undefined
  const chatStartedAt = Date.now()
  let lastStats: ChatStats | undefined
  const onRunSigint = () => {
    if (activeController) {
      activeController.abort()
      process.stdout.write("\nCancelled current run.\n")
      return
    }
    if (interruptArmed) {
      process.stdout.write("\n")
      exitRequested = true
      input.interrupt()
      input.close()
      return
    }
    input.interrupt()
  }
  process.on("SIGINT", onRunSigint)
  try {
    while (true) {
      const message = await askChatInput(input, terminal, {
        model: runtime.config.model,
        permissionMode,
        ...(activeSessionId ? { activeSessionId } : {}),
        interruptArmed,
      })
      if (exitRequested) break
      if (message === undefined) break
      if (message === CHAT_CTRL_C) {
        if (interruptArmed) {
          exitRequested = true
          input.close()
          break
        }
        interruptArmed = true
        process.stdout.write("Press Ctrl-C again to exit.\n")
        continue
      }
      interruptArmed = false
      const command = message.trim()
      if (!command) continue
      if (["exit", "quit", "/exit"].includes(command)) break
      if (command === "/help" || command === "?") {
        process.stdout.write(`${chatHelp()}\n`)
        continue
      }
      if (command === "/clear") {
        process.stdout.write(process.stdout.isTTY ? clearTerminalSequence() : "\n")
        continue
      }
      if (command === "/tools") {
        process.stdout.write(`${formatToolList(runtime.tools.list())}\n`)
        continue
      }
      if (command === "/session") {
        process.stdout.write(`${activeSessionId ? `session: ${activeSessionId}` : "session: new"}\n`)
        continue
      }
      if (command === "/model") {
        process.stdout.write(`model: ${runtime.config.model}\n`)
        continue
      }
      if (command === "/config") {
        process.stdout.write(`${formatProviderConfig(runtime.config)}\n`)
        continue
      }
      if (command.startsWith("/config ")) {
        const result = await chatConfigCommand(command.slice("/config ".length).trim(), input)
        if (result.output) process.stdout.write(`${result.output}\n`)
        if (result.exitCode === 0 && result.reload) await reloadRuntime()
        continue
      }
      if (command === "/mcp") {
        const statuses = await inspectMCPServers(runtime.config)
        process.stdout.write(`${statuses.length ? formatMCPStatusTable(statuses) : "No MCP servers configured."}\n`)
        continue
      }
      if (command === "/skills") {
        const skills = await runtime.skills.list()
        process.stdout.write(`${skills.length ? formatSkillList(skills) : "No skills discovered."}\n`)
        continue
      }
      if (command === "/doctor") {
        process.stdout.write(`${(await doctor()).output}\n`)
        continue
      }
      process.stdout.write(renderChatUserMessage(message, terminal, input.echoesUserInput))
      const stats: ChatStats = {
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        model: runtime.config.model,
        startedAt: Date.now(),
        apiMs: 0,
        inputTokens: approximateTokens(message),
        outputTokens: 0,
        toolCalls: 0,
      }
      lastStats = stats
      if (!hasRuntimeLLM(runtime)) {
        process.stdout.write(`${terminal.red("No provider API key configured.")}\n`)
        process.stdout.write("Run `/config setup`, or `/config use <baseURL|alias> <apiKey> [model]`, then try again.\n")
        continue
      }
      const status = createChatRunStatus(terminal, stats)
      activeStatus = status
      const trace = new CliTraceRenderer({ write: (chunk) => process.stdout.write(chunk), noColor, verbose, terminal, style: "codebuddy" })
      activeController = new AbortController()
      try {
        for await (const event of runtime.runner.run(
          activeSessionId
            ? { message, sessionId: activeSessionId, signal: activeController.signal }
            : { message, signal: activeController.signal },
        )) {
          status.handle(event)
          if (event.type === "session_created") {
            activeSessionId = event.sessionId
            stats.sessionId = event.sessionId
          }
          trace.handle(event)
          if (event.type === "llm_text_delta") {
            output += event.text
            stats.outputTokens += approximateTokens(event.text)
          }
        }
      } finally {
        activeController = undefined
        if (activeStatus === status) activeStatus = undefined
        status.finish()
      }
      trace.finish()
    }
  } finally {
    process.off("SIGINT", onRunSigint)
    input.close()
    await runtime.close()
  }
  process.stdout.write(formatChatSummary({
    terminal,
    chatStartedAt,
    ...(lastStats ? { stats: lastStats } : {}),
    ...(activeSessionId ? { activeSessionId } : {}),
  }))
  return { exitCode: 0 }
}

async function buildChatRuntime(
  config: MinicodeConfig,
  permissionMode: PermissionMode,
  askPermission: (request: PermissionRequest, decision: PermissionDecision) => Promise<PermissionDecision>,
) {
  const common = {
    config,
    yes: permissionMode === "bypassPermissions",
    permissionMode,
    interactivePermissions: permissionMode !== "bypassPermissions" && permissionMode !== "plan",
    askPermission,
  }
  if (!hasConfiguredProviderKey(config)) return await buildRuntime({ ...common, loadLLM: false })
  return await buildRuntime(common)
}

function hasRuntimeLLM(runtime: Runtime | RuntimeWithoutLLM): runtime is Runtime {
  return Boolean(runtime.runner)
}

function hasConfiguredProviderKey(config: MinicodeConfig) {
  const provider = config.providers["openai-compatible"]
  return Boolean(provider?.apiKey || (provider?.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined))
}

async function chatConfigCommand(raw: string, input: ChatInput): Promise<CliResult & { reload?: boolean }> {
  const args = raw ? raw.split(/\s+/).filter(Boolean) : ["show"]
  if (args[0] === "setup") {
    const result = await configureProviderInteractively(input)
    return { exitCode: 0, output: formatProviderConfigResult(result), reload: true }
  }
  const result = await configCommand(args)
  return { ...result, reload: ["set", "use", "use-env", "setup"].includes(args[0] ?? "") }
}

async function askChatInput(
  input: ChatInput,
  terminal: ReturnType<typeof createTerminal>,
  options: { model: string; permissionMode: PermissionMode; activeSessionId?: string; interruptArmed: boolean },
) {
  const prompt = chatPrompt(terminal, options)
  const firstLine = await input.question(prompt)
  if (firstLine === undefined || firstLine === CHAT_CTRL_C) return firstLine
  if (firstLine.trim() !== "/paste") return firstLine

  process.stdout.write(`${terminal.gray("Multiline input: finish with a single '.', cancel with /cancel or Ctrl-C.")}\n`)
  const lines: string[] = []
  while (true) {
    const line = await input.question(`${terminal.gray("...")} `)
    if (line === undefined) return lines.length ? lines.join("\n") : undefined
    if (line === CHAT_CTRL_C || line.trim() === "/cancel") {
      process.stdout.write("Multiline input cancelled.\n")
      return ""
    }
    if (line === ".") return lines.join("\n")
    lines.push(line)
  }
}

async function createChatInput(): Promise<ChatInput> {
  if (process.stdin.isTTY) {
    let history: string[] = []
    let closed = false
    let rl: ReturnType<typeof createInterface>
    let pendingQuestion: AbortController | undefined
    const rememberHistory = () => {
      const value = (rl as ReturnType<typeof createInterface> & { history?: string[] }).history
      if (Array.isArray(value)) history = [...value]
    }
    const createReadline = () => {
      const next = createInterface({
        input: process.stdin,
        output: process.stdout,
        historySize: 500,
        removeHistoryDuplicates: true,
      })
      if (history.length) (next as ReturnType<typeof createInterface> & { history?: string[] }).history = [...history]
      closed = false
      next.once("close", () => {
        if (rl === next) closed = true
      })
      return next
    }
    rl = createReadline()
    return {
      isTTY: true,
      echoesUserInput: true,
      writesPrompt: true,
      async question(prompt: string) {
        if (closed) rl = createReadline()
        const controller = new AbortController()
        pendingQuestion = controller
        try {
          return await askReadline(rl, prompt, controller.signal)
        } finally {
          if (pendingQuestion === controller) pendingQuestion = undefined
        }
      },
      prompt() {
        if (closed) rl = createReadline()
        rl.prompt()
      },
      interrupt() {
        pendingQuestion?.abort()
      },
      suspend() {
        if (closed) return
        rememberHistory()
        rl.close()
      },
      resume() {
        if (closed) rl = createReadline()
        else rl.resume()
      },
      close() {
        pendingQuestion?.abort()
        if (closed) return
        rememberHistory()
        rl.close()
      },
    }
  }

  const text = await readPipedStdin()
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  if (text.endsWith("\n")) lines.pop()
  let index = 0
  return {
    isTTY: false,
    echoesUserInput: true,
    writesPrompt: true,
    async question(prompt: string) {
      if (prompt) process.stdout.write(prompt)
      if (index >= lines.length) return undefined
      const line = lines[index]
      index += 1
      if (line) process.stdout.write(`${line}\n`)
      return line ?? ""
    },
    prompt() {},
    interrupt() {},
    close() {},
  }
}

async function readPipedStdin() {
  let text = ""
  for await (const chunk of process.stdin) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
  }
  return text
}

async function askReadline(rl: ReturnType<typeof createInterface>, prompt: string, signal?: AbortSignal) {
  try {
    return signal ? await rl.question(prompt, { signal }) : await rl.question(prompt)
  } catch (error) {
    if (isReadlineControlError(error, "SIGINT")) return CHAT_CTRL_C
    if (isAbortError(error)) return CHAT_CTRL_C
    if (isReadlineControlError(error, "EOF")) return undefined
    throw error
  }
}

function isReadlineControlError(error: unknown, code: "SIGINT" | "EOF") {
  if (isRecord(error) && error.code === code) return true
  return code === "EOF" && error instanceof Error && /readline was closed/i.test(error.message)
}

function isAbortError(error: unknown) {
  if (!isRecord(error)) return false
  return error.name === "AbortError" || error.code === "ABORT_ERR" || error.code === "ERR_ABORTED"
}

function clearTerminalForChat() {
  process.stdout.write(clearTerminalSequence())
}

function clearTerminalSequence() {
  return "\x1b[H\x1b[2J\x1b[3J\x1b[H"
}

function chatPrompt(
  terminal: ReturnType<typeof createTerminal>,
  options: { model: string; permissionMode: PermissionMode; activeSessionId?: string; interruptArmed: boolean },
) {
  if (terminal.width >= 88) {
    const width = panelWidthForTerminal(terminal.width)
    return `${divider(width, terminal)}\n${terminal.blue(">")} `
  }
  return `${terminal.blue(">")} `
}

function stripPromptAnsi(value: string) {
  return stripAnsi(value)
}

function shortModel(model: string) {
  const parts = model.split("/")
  return parts[parts.length - 1] || model
}

function shortSession(sessionId: string) {
  if (sessionId.length <= 18) return sessionId
  return `${sessionId.slice(0, 10)}...${sessionId.slice(-5)}`
}

function chatHelp() {
  return [
    "Slash commands:",
    "/help     show this help",
    "/clear    clear the terminal",
    "/paste    enter multiline input; finish with '.', cancel with /cancel",
    "/tools    list available tools",
    "/session  show the active session",
    "/model    show the active model",
    "/config   show or set provider config",
    "/mcp      show MCP server status",
    "/skills   list discovered skills",
    "/doctor   run local diagnostics",
    "/exit     exit chat",
  ].join("\n")
}

function renderChatUserMessage(message: string, terminal: ReturnType<typeof createTerminal>, alreadyEchoed = false) {
  if (alreadyEchoed) return "\n"
  const text = message.trimEnd()
  if (!text) return ""
  const lines = text.split("\n")
  if (lines.length === 1) return `${terminal.blue(">")} ${terminal.bold(oneLine(lines[0] ?? "", Math.min(terminal.width - 8, 120)))}\n\n`
  return [`${terminal.blue(">")} ${terminal.bold("[multiline]")}`, ...lines.map((line) => `${terminal.blue("|")} ${line}`), ""].join("\n")
}

function createChatRunStatus(terminal: ReturnType<typeof createTerminal>, stats: ChatStats) {
  const startedAt = Date.now()
  const frames = ["✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷"]
  const tips = [
    "Use /paste for multiline input.",
    "Ctrl-C cancels the current run.",
    "Use minicode -c to continue the latest session.",
  ]
  let printed = false
  let visible = false
  let paused = false
  let done = false
  let frame = 0
  let mode = "Waking"
  let detail = "waiting for model"
  const clearVisibleLine = () => {
    if (!visible || !process.stdout.isTTY) return
    process.stdout.write("\r\x1b[2K")
    visible = false
  }
  const render = () => {
    if (done || paused) return
    if (!process.stdout.isTTY) return
    printed = true
    const line = `${terminal.blue(frames[frame % frames.length] ?? "✺")} ${mode}… (${formatDurationShort(Date.now() - startedAt)} · ${detail} · ↑ ${formatTokenCount(stats.inputTokens)} tokens · esc to interrupt)`
    frame += 1
    process.stdout.write(`\r\x1b[2K${line}`)
    visible = true
  }
  const timer = setInterval(render, 1000)
  const initial = setTimeout(render, 250)
  return {
    handle(event: AgentEvent) {
      if (event.type === "tool_call") {
        stats.toolCalls += 1
        mode = "Monitoring"
        detail = `running ${event.name}`
        clearVisibleLine()
      }
      if (event.type === "tool_result") {
        mode = "Monitoring"
        detail = `${event.name} ${event.ok ? "finished" : "failed"}`
        this.finish()
      }
      if (event.type === "llm_text_delta" || event.type === "message" || event.type === "error") this.finish()
    },
    pause() {
      if (done) return
      paused = true
      clearVisibleLine()
    },
    resume() {
      if (done) return
      paused = false
      render()
    },
    finish() {
      if (done) return
      done = true
      stats.apiMs += Date.now() - startedAt
      clearTimeout(initial)
      clearInterval(timer)
      if (printed) {
        clearVisibleLine()
      }
    },
  }
}

function formatDurationShort(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

function formatTokenCount(tokens: number) {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
}

function formatChatSummary(options: {
  terminal: ReturnType<typeof createTerminal>
  chatStartedAt: number
  stats?: ChatStats
  activeSessionId?: string
}) {
  if (!options.stats) return ""
  const wallMs = Date.now() - options.chatStartedAt
  const lines = [
    "",
    options.terminal.blue("Session summary"),
    `${options.terminal.gray("Total duration (API):")}  ${formatDurationDetailed(options.stats.apiMs)}`,
    `${options.terminal.gray("Total duration (wall):")} ${formatDurationDetailed(wallMs)}`,
    `${options.terminal.gray("Tool calls:")}           ${options.stats.toolCalls}`,
    options.terminal.gray("Usage by model:"),
    `      ${options.terminal.blue(shortModelFromStats(options.stats))}:      ${formatTokenCount(options.stats.inputTokens)} input, ${formatTokenCount(options.stats.outputTokens)} output`,
    "",
    options.activeSessionId ? `${options.terminal.gray("To resume this session:")} minicode --session ${options.activeSessionId}` : undefined,
    `${options.terminal.gray("or resume last session:")} minicode -c`,
  ].filter((line): line is string => line !== undefined)
  return `${lines.join("\n")}\n`
}

function shortModelFromStats(_stats: ChatStats) {
  return shortModel(_stats.model)
}

function formatDurationDetailed(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`
}

function createCliPermissionAsk(
  input: ChatInput,
  terminal: ReturnType<typeof createTerminal>,
  hooks: { beforePrompt?: () => void; afterPrompt?: () => void } = {},
) {
  const sessionApprovals = new Map<string, PermissionDecision>()
  return async (request: PermissionRequest, decision: PermissionDecision): Promise<PermissionDecision> => {
    const approvalKey = permissionApprovalKey(request, decision)
    const approved = sessionApprovals.get(approvalKey)
    if (approved) {
      return {
        ...decision,
        action: "allow",
        originalAction: "ask",
        reason: `approved for this chat session: ${approved.reason}`,
      }
    }
    hooks.beforePrompt?.()
    let answer: string | undefined
    try {
      answer = await readPermissionChoice(input, request, decision, terminal)
    } finally {
      hooks.afterPrompt?.()
    }
    const choice = permissionChoiceFromAnswer(answer)
    if (choice === "session") {
      const approvedDecision = {
        ...decision,
        action: "allow" as const,
        originalAction: "ask" as const,
        reason: `approved for this chat session: ${decision.reason}`,
      }
      sessionApprovals.set(approvalKey, approvedDecision)
      return approvedDecision
    }
    if (choice === "once") {
      return {
        ...decision,
        action: "allow",
        originalAction: "ask",
        reason: `approved once: ${decision.reason}`,
      }
    }
    return {
      ...decision,
      action: "deny",
      originalAction: "ask",
      reason: `denied by user: ${decision.reason}`,
    }
  }
}

type PermissionChoice = "once" | "session" | "deny"

async function readPermissionChoice(
  input: ChatInput,
  request: PermissionRequest,
  decision: PermissionDecision,
  terminal: ReturnType<typeof createTerminal>,
) {
  if (canUseRawPermissionMenu(input)) return selectPermissionChoice(request, decision, terminal, input)

  const prompt = formatPermissionPrompt(request, decision, terminal)
  const answer = await input.question(prompt)
  process.stdout.write("\n")
  return answer
}

function canUseRawPermissionMenu(input: ChatInput) {
  const stdin = process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => typeof process.stdin }
  return Boolean(input.isTTY && process.stdout.isTTY && stdin.setRawMode)
}

function permissionChoiceFromAnswer(answer: string | undefined): PermissionChoice {
  const value = (answer ?? "").trim()
  if (/^(2|a|always)$/i.test(value)) return "session"
  if (/^(1|y|yes)$/i.test(value)) return "once"
  return "deny"
}

async function selectPermissionChoice(
  request: PermissionRequest,
  decision: PermissionDecision,
  terminal: ReturnType<typeof createTerminal>,
  input: ChatInput,
) {
  const stdin = process.stdin as typeof process.stdin & {
    isRaw?: boolean
    setRawMode?: (mode: boolean) => typeof process.stdin
  }
  const wasRaw = Boolean(stdin.isRaw)
  let selected = 0
  let renderedRows = 0

  const erase = () => {
    if (!renderedRows) return
    process.stdout.write(`\x1b[${renderedRows}A`)
    for (let row = 0; row < renderedRows; row += 1) {
      process.stdout.write("\r\x1b[2K")
      if (row < renderedRows - 1) process.stdout.write("\x1b[1B")
    }
    if (renderedRows > 1) process.stdout.write(`\x1b[${renderedRows - 1}A`)
    process.stdout.write("\r")
    renderedRows = 0
  }
  const render = () => {
    erase()
    const lines = formatPermissionPromptLines(request, decision, terminal, { selected })
    process.stdout.write(`${lines.join("\n")}\n`)
    renderedRows = renderedRowCount(lines, terminal)
  }

  input.suspend?.()
  stdin.setRawMode?.(true)
  stdin.resume()
  render()

  return await new Promise<string>((resolve) => {
    let resolved = false
    const choose = (answer: string) => {
      if (resolved) return
      resolved = true
      stdin.off("data", onData)
      erase()
      stdin.setRawMode?.(wasRaw)
      input.resume?.()
      resolve(answer)
    }
    const move = (delta: number) => {
      selected = (selected + delta + 3) % 3
      render()
    }
    const onData = (chunk: Buffer | string) => {
      const keys = chunk.toString("utf8")
      for (let index = 0; index < keys.length && !resolved; ) {
        const rest = keys.slice(index)
        const key = keys[index] ?? ""
        if (rest.startsWith("\x1b[A")) {
          move(-1)
          index += 3
          continue
        }
        if (rest.startsWith("\x1b[B")) {
          move(1)
          index += 3
          continue
        }
        if (key === "\r" || key === "\n") {
          choose(String(selected + 1))
          index += 1
          continue
        }
        if (/^[123]$/.test(key)) {
          choose(key)
          index += 1
          continue
        }
        if (/^y$/i.test(key)) {
          choose("1")
          index += 1
          continue
        }
        if (/^a$/i.test(key)) {
          choose("2")
          index += 1
          continue
        }
        if (/^n$/i.test(key) || key === "\x1b" || key === "\x03" || key === "\x04") {
          choose("3")
          index += 1
          continue
        }
        index += 1
      }
    }
    stdin.on("data", onData)
  })
}

function formatPermissionPrompt(
  request: PermissionRequest,
  decision: PermissionDecision,
  terminal: ReturnType<typeof createTerminal>,
) {
  return `${formatPermissionPromptLines(request, decision, terminal, { selected: 0 }).join("\n")}\nChoose [1/2/3, y/a/N]: `
}

function formatPermissionPromptLines(
  request: PermissionRequest,
  decision: PermissionDecision,
  terminal: ReturnType<typeof createTerminal>,
  options: { selected: number },
) {
  const width = permissionPanelWidth(terminal)
  const target = permissionTarget(request)
  const option = (index: number, text: string) => {
    const marker = options.selected === index ? terminal.blue(">") : " "
    const value = `${marker} ${index + 1}. ${text}`
    return options.selected === index ? terminal.bold(value) : value
  }
  return [
    terminal.blue(`┏${"━".repeat(width - 2)}┓`),
    panelLine("Permission required", width, terminal.bold(request.tool), terminal),
    panelLine("", width, target, terminal),
    panelLine("", width, decision.reason, terminal),
    panelLine("", width, "", terminal),
    panelLine("", width, "Do you want to allow minicode to run this tool?", terminal),
    panelLine("", width, "Use ↑/↓ then Enter, or press 1/2/3.", terminal),
    panelLine("", width, "", terminal),
    panelLine("", width, option(0, "Yes"), terminal),
    panelLine("", width, option(1, "Yes, and don't ask again for this chat"), terminal),
    panelLine("", width, option(2, "No"), terminal),
    terminal.blue(`┗${"━".repeat(width - 2)}┛`),
  ]
}

function permissionPanelWidth(terminal: ReturnType<typeof createTerminal>) {
  const columns = Math.max(32, process.stdout.columns ?? terminal.width)
  return Math.max(30, Math.min(columns - 6, 112))
}

function renderedRowCount(lines: string[], terminal: ReturnType<typeof createTerminal>) {
  const columns = Math.max(1, process.stdout.columns ?? terminal.width)
  return lines.reduce((count, line) => count + Math.max(1, Math.ceil(displayWidth(line) / columns)), 0)
}

function panelLine(label: string, width: number, value: string, terminal = createTerminal()) {
  const prefix = label ? ` ${label} ` : " "
  const text = `${prefix}${value}`
  const rendered = truncateForPanel(text, width - 4)
  return `${terminal.blue("┃")} ${rendered}${" ".repeat(Math.max(0, width - 4 - displayWidth(rendered)))} ${terminal.blue("┃")}`
}

function truncateForPanel(value: string, width: number) {
  if (displayWidth(value) <= width) return value
  let output = ""
  let current = 0
  const target = Math.max(0, width - 3)
  for (const char of stripAnsi(value)) {
    const charWidth = displayWidth(char)
    if (current + charWidth > target) break
    output += char
    current += charWidth
  }
  return `${output}...`
}

function permissionTarget(request: PermissionRequest) {
  const input = request.input
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    for (const key of ["command", "path", "url", "query"]) {
      const value = record[key]
      if (typeof value === "string" && value) return value
    }
  }
  return request.risk ? `risk: ${request.risk}` : ""
}

function permissionApprovalKey(request: PermissionRequest, decision: PermissionDecision) {
  const rule = decision.rule
  if (rule) return [request.tool, rule.index, rule.tool ?? "", rule.pattern ?? ""].join(":")
  return [request.tool, request.risk ?? "", decision.reason].join(":")
}

async function sessionCommand(args: string[]): Promise<CliResult> {
  const runtime = await buildRuntime({ loadLLM: false })
  const [subcommand, sessionId] = args
  if (subcommand === "list" || subcommand === "ls") {
    const sessions = await runtime.sessions.listSessions()
    if (!sessions.length) return { exitCode: 0, output: "" }
    return {
      exitCode: 0,
      output: table([
        ["latest", "session", "updated", "title"],
        ...sessions.map((session, index) => [index === 0 ? "*" : "", session.id, session.updatedAt, session.title ?? ""]),
      ], { header: true }),
    }
  }
  if (subcommand === "show" && sessionId) {
    const session = await runtime.sessions.getSession(sessionId)
    const messages = await runtime.sessions.readMessages(sessionId)
    return { exitCode: session ? 0 : 1, output: JSON.stringify({ session, messages }, null, 2) }
  }
  if (subcommand === "resume") {
    const latest = await latestSessionId(runtime)
    if (!latest) throw new MinicodeError("No sessions to resume", { code: "SESSION_NOT_FOUND" })
    return { exitCode: 0, output: latest }
  }
  throw new MinicodeError("session requires list, resume, or show <session-id>", { code: "CLI_USAGE" })
}

async function configCommand(args: string[]): Promise<CliResult> {
  const config = await loadConfig()
  const [subcommand, key] = args
  if (subcommand === "validate") {
    validateConfig(config)
    return { exitCode: 0, output: "config ok" }
  }
  if (subcommand === "show" || subcommand === undefined) return { exitCode: 0, output: formatProviderConfig(config) }
  if (subcommand === "list" || subcommand === "ls") return { exitCode: 0, output: JSON.stringify(redactConfig(config), null, 2) }
  if (subcommand === "get" && key) {
    return { exitCode: 0, output: JSON.stringify(readConfigPath(redactConfig(config), key), null, 2) }
  }
  if (subcommand === "use") {
    const result = await configureProviderFromArgs(args.slice(1), "apiKey")
    return { exitCode: 0, output: formatProviderConfigResult(result) }
  }
  if (subcommand === "use-env") {
    const result = await configureProviderFromArgs(args.slice(1), "apiKeyEnv")
    return { exitCode: 0, output: formatProviderConfigResult(result) }
  }
  if (subcommand === "setup") {
    throw new MinicodeError("config setup is interactive. Run it inside chat as `/config setup`.", { code: "CLI_USAGE" })
  }
  if (subcommand === "set" && key) {
    const raw = args.slice(2).join(" ")
    if (!raw) throw new MinicodeError("config set requires a value", { code: "CLI_USAGE" })
    const projectConfig = await readProjectConfig()
    writeConfigPath(projectConfig, key, parseConfigValue(raw))
    await writeProjectConfig(projectConfig)
    return { exitCode: 0, output: `set ${key}` }
  }
  throw new MinicodeError(
    "config requires show, setup, use <baseURL|alias> <apiKey> [model], use-env <baseURL|alias> <ENV_VAR> [model], validate, list, get <key>, or set <key> <value>",
    { code: "CLI_USAGE" },
  )
}

async function toolCommand(args: string[]): Promise<CliResult> {
  if (args[0] !== "list") throw new MinicodeError("tool requires list", { code: "CLI_USAGE" })
  const runtime = await buildRuntime({ loadLLM: false })
  return { exitCode: 0, output: formatToolList(runtime.tools.list()) }
}

async function skillCommand(args: string[]): Promise<CliResult> {
  const [subcommand, ...rest] = args
  const runtime = await buildRuntime({ loadLLM: false, yes: has(args, "--yes") })
  const json = has(rest, "--json")
  if (subcommand === "init") {
    const descriptionFlag = takeFlagValue(rest, "--description")
    const pathFlag = takeFlagValue(descriptionFlag.args, "--path")
    const name = stripFlags(pathFlag.args, ["--yes", "--json"]).join(" ").trim()
    if (!name) throw new MinicodeError("skill init requires a name", { code: "CLI_USAGE" })
    const result = await initSkill({
      name,
      ...(descriptionFlag.value ? { description: descriptionFlag.value } : {}),
      ...(pathFlag.value ? { skillsDir: pathFlag.value } : {}),
      config: runtime.config,
      cwd: runtime.cwd,
      yes: has(args, "--yes"),
    })
    if (json) return { exitCode: 0, output: JSON.stringify(result, null, 2) }
    return { exitCode: 0, output: `created skill ${result.name} at ${result.skillPath}` }
  }
  if (subcommand === "list") {
    const skills = await runtime.skills.list()
    if (json) {
      return { exitCode: 0, output: JSON.stringify({ skills, diagnostics: await runtime.skills.diagnostics() }, null, 2) }
    }
    return { exitCode: 0, output: formatSkillList(skills) }
  }
  if (subcommand === "show") {
    const skill = await runtime.skills.load(stripFlags(rest, ["--json"]).join(" "))
    if (json) return { exitCode: 0, output: JSON.stringify(skill, null, 2) }
    return { exitCode: 0, output: skill.content }
  }
  if (subcommand === "search") {
    const remote = has(rest, "--remote")
    const query = stripFlags(rest, ["--json", "--remote"]).join(" ")
    if (remote) {
      const provider = skillHub(runtime.config)
      const skills = await provider.search(query)
      if (json) return { exitCode: 0, output: JSON.stringify({ skills }, null, 2) }
      return { exitCode: 0, output: table([["id", "skill", "description", "source"], ...skills.map((skill) => [skill.id, skill.name, skill.description, skill.source])], { header: true }) }
    }
    const skills = await runtime.skills.search(query)
    if (json) return { exitCode: 0, output: JSON.stringify({ skills, diagnostics: await runtime.skills.diagnostics() }, null, 2) }
    return { exitCode: 0, output: formatSkillList(skills) }
  }
  if (subcommand === "path") {
    const [pathCommand, ...pathRest] = rest
    return skillPathCommand(pathCommand, pathRest)
  }
  if (subcommand === "doctor") {
    const skills = await runtime.skills.list()
    const diagnostics = await runtime.skills.diagnostics()
    const result = {
      paths: runtime.config.skills.paths,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.source.relativePath,
        duplicates: skill.duplicates?.length ?? 0,
      })),
      diagnostics,
    }
    if (json) return { exitCode: diagnostics.length ? 1 : 0, output: JSON.stringify(result, null, 2) }
    const lines = [
      "skill doctor",
      `paths: ${runtime.config.skills.paths.join(", ") || "(none)"}`,
      `skills: ${skills.length}`,
      `diagnostics: ${diagnostics.length}`,
      ...diagnostics.map((item) => `- ${item.code}: ${item.message}`),
    ]
    return { exitCode: diagnostics.length ? 1 : 0, output: lines.join("\n") }
  }
  if (subcommand === "install") {
    const id = rest.find((arg) => !["--yes", "--json"].includes(arg))
    if (!id) throw new MinicodeError("skill install requires remote-skill-id", { code: "CLI_USAGE" })
    const provider = skillHub(runtime.config)
    const detail = await provider.detail(id)
    const installRoot = runtime.config.skillhub.installDir.startsWith("/")
      ? runtime.config.skillhub.installDir
      : resolve(runtime.cwd, runtime.config.skillhub.installDir)
    const plan = planSkillInstall(detail, installRoot)
    if (!has(args, "--yes")) {
      const output = json ? JSON.stringify({ requiresConfirmation: true, plan }, null, 2) : `${formatSkillInstallPlan(plan)}\nRe-run with --yes to install.`
      return { exitCode: 1, output }
    }
    const result = await installRemoteSkill(detail, installRoot)
    return { exitCode: 0, output: json ? JSON.stringify({ installed: result }, null, 2) : formatSkillInstallResult(result) }
  }
  throw new MinicodeError("skill requires init, list, show, search, path, doctor, or install", { code: "CLI_USAGE" })
}

async function skillPathCommand(subcommand: string | undefined, args: string[]): Promise<CliResult> {
  const json = has(args, "--json")
  if (subcommand === "list") {
    const config = await loadConfig()
    if (json) return { exitCode: 0, output: JSON.stringify({ paths: config.skills.paths }, null, 2) }
    return { exitCode: 0, output: config.skills.paths.join("\n") }
  }
  if (subcommand === "add") {
    const path = stripFlags(args, ["--json"]).join(" ").trim()
    if (!path) throw new MinicodeError("skill path add requires a path", { code: "CLI_USAGE" })
    const config = await readProjectConfig()
    const paths = projectSkillPaths(config)
    const changed = !paths.includes(path)
    if (changed) paths.push(path)
    setProjectSkillPaths(config, paths)
    await writeProjectConfig(config)
    const result = { path, paths, changed }
    if (json) return { exitCode: 0, output: JSON.stringify(result, null, 2) }
    return { exitCode: 0, output: changed ? `added skill path ${path}` : `skill path already present ${path}` }
  }
  if (subcommand === "remove") {
    const path = stripFlags(args, ["--json"]).join(" ").trim()
    if (!path) throw new MinicodeError("skill path remove requires a path", { code: "CLI_USAGE" })
    const config = await readProjectConfig()
    const paths = projectSkillPaths(config)
    const next = paths.filter((item) => item !== path)
    const changed = next.length !== paths.length
    setProjectSkillPaths(config, next)
    await writeProjectConfig(config)
    const result = { path, paths: next, changed }
    if (json) return { exitCode: 0, output: JSON.stringify(result, null, 2) }
    return { exitCode: 0, output: changed ? `removed skill path ${path}` : `skill path not present ${path}` }
  }
  throw new MinicodeError("skill path requires list, add, or remove", { code: "CLI_USAGE" })
}

async function initSkill(options: {
  name: string
  description?: string
  skillsDir?: string
  config: MinicodeConfig
  cwd: string
  yes: boolean
}) {
  const name = safeSkillName(options.name)
  const skillsDir = options.skillsDir ?? options.config.skillhub.installDir ?? options.config.skills.paths[0] ?? ".minicode/skills"
  const root = skillsDir.startsWith("/") ? skillsDir : resolve(options.cwd, skillsDir)
  const targetDir = join(root, name)
  const skillPath = join(targetDir, "SKILL.md")
  if (!options.yes && (await exists(skillPath))) {
    throw new MinicodeError(`Skill already exists: ${skillPath}. Re-run with --yes to overwrite.`, { code: "SKILL_EXISTS" })
  }
  await mkdir(targetDir, { recursive: true })
  const description = options.description ?? `Use this skill for ${name} workflows.`
  await writeFile(
    skillPath,
    ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`, "", "## When To Use", "", description, ""].join("\n"),
    "utf8",
  )
  return { name, description, skillsDir, targetDir, skillPath }
}

function safeSkillName(name: string) {
  const safe = name.trim().replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "")
  if (!safe) throw new MinicodeError(`Invalid skill name: ${name}`, { code: "SKILL_INVALID_NAME" })
  return safe
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readProjectConfig() {
  const configPath = resolve(process.cwd(), "minicode.jsonc")
  if (!(await exists(configPath))) return {}
  const config = await readJsoncFile<Record<string, unknown>>(configPath)
  if (!isRecord(config)) throw new MinicodeError("minicode.jsonc must contain an object", { code: "CONFIG_INVALID" })
  return config
}

async function writeProjectConfig(config: Record<string, unknown>) {
  const configPath = resolve(process.cwd(), "minicode.jsonc")
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

async function configureProviderFromArgs(args: string[], credential: "apiKey" | "apiKeyEnv"): Promise<ProviderConfigResult> {
  const [endpoint, credentialValue, model] = args
  if (!endpoint || !credentialValue) {
    throw new MinicodeError(
      credential === "apiKey"
        ? "config use requires <baseURL|alias> <apiKey> [model]"
        : "config use-env requires <baseURL|alias> <ENV_VAR> [model]",
      { code: "CLI_USAGE" },
    )
  }
  return await saveProviderConfig({
    endpoint,
    credential,
    credentialValue,
    ...(model ? { model } : {}),
  })
}

async function configureProviderInteractively(input: ChatInput): Promise<ProviderConfigResult> {
  const current = await loadConfig()
  const currentProvider = current.providers["openai-compatible"]
  const defaultEndpoint = currentProvider?.baseURL ?? defaultConfig.providers["openai-compatible"].baseURL ?? "https://api.openai.com/v1"
  const defaultModel = current.model || "openai-compatible/example-model"
  const endpointAnswer = await input.question(`Base URL or alias [${defaultEndpoint}]: `)
  const endpoint = endpointAnswer?.trim() || defaultEndpoint
  const modelAnswer = await input.question(`Model [${defaultModel}]: `)
  const model = modelAnswer?.trim() || defaultModel
  const modeAnswer = await input.question("Credential mode [key/env]: ")
  const credential: "apiKey" | "apiKeyEnv" = /^env$/i.test(modeAnswer?.trim() ?? "") ? "apiKeyEnv" : "apiKey"
  const prompt = credential === "apiKey" ? "API key: " : "API key env var [MINICODE_API_KEY]: "
  const credentialAnswer = await input.question(prompt)
  const credentialValue = credentialAnswer?.trim() || (credential === "apiKeyEnv" ? "MINICODE_API_KEY" : "")
  if (!credentialValue) throw new MinicodeError("API key is required", { code: "CLI_USAGE" })
  return await saveProviderConfig({ endpoint, credential, credentialValue, model })
}

async function saveProviderConfig(options: {
  endpoint: string
  credential: "apiKey" | "apiKeyEnv"
  credentialValue: string
  model?: string
}): Promise<ProviderConfigResult> {
  const baseURL = normalizeProviderEndpoint(options.endpoint)
  const model = options.model?.trim() || (await loadConfig()).model
  const projectConfig = await readProjectConfig()
  const providers = isRecord(projectConfig.providers) ? { ...projectConfig.providers } : {}
  const existing = isRecord(providers["openai-compatible"]) ? providers["openai-compatible"] : {}
  providers["openai-compatible"] = {
    ...existing,
    type: "openai-compatible",
    baseURL,
    ...(options.credential === "apiKey"
      ? { apiKey: options.credentialValue, apiKeyEnv: undefined }
      : { apiKeyEnv: options.credentialValue, apiKey: undefined }),
  }
  projectConfig.providers = providers
  projectConfig.model = model
  const agents = isRecord(projectConfig.agents) ? { ...projectConfig.agents } : {}
  const defaultAgent = isRecord(agents.default) ? { ...agents.default } : {}
  if (typeof defaultAgent.model === "string") delete defaultAgent.model
  if (Object.keys(defaultAgent).length) {
    agents.default = defaultAgent
    projectConfig.agents = agents
  }
  await writeProjectConfig(removeUndefinedDeep(projectConfig) as Record<string, unknown>)
  return {
    baseURL,
    model,
    credential: options.credential,
    ...(options.credential === "apiKeyEnv" ? { apiKeyEnv: options.credentialValue } : {}),
  }
}

function normalizeProviderEndpoint(value: string) {
  const trimmed = value.trim()
  const alias = PROVIDER_ENDPOINT_ALIASES[trimmed.toLowerCase()]
  const endpoint = alias ?? trimmed
  assertHTTPURL(endpoint, "Provider API URL")
  return endpoint.replace(/\/+$/, "")
}

function formatProviderConfig(config: MinicodeConfig) {
  const provider = config.providers["openai-compatible"]
  const credential = provider?.apiKey ? "apiKey configured" : provider?.apiKeyEnv ? `env ${provider.apiKeyEnv}` : "not configured"
  return [
    "Provider config",
    `baseURL: ${provider?.baseURL ?? "(not set)"}`,
    `model: ${config.model}`,
    `credential: ${credential}`,
    "",
    "Quick setup:",
    "  /config setup",
    "  /config use siliconflow <api-key> deepseek-ai/DeepSeek-V3.2",
    "  /config use-env siliconflow MINICODE_API_KEY deepseek-ai/DeepSeek-V3.2",
  ].join("\n")
}

function formatProviderConfigResult(result: ProviderConfigResult) {
  return [
    "Provider config saved.",
    `baseURL: ${result.baseURL}`,
    `model: ${result.model}`,
    `credential: ${result.credential === "apiKey" ? "apiKey configured" : `env ${result.apiKeyEnv ?? ""}`}`,
    "The chat runtime has been reloaded.",
  ].join("\n")
}

function removeUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefinedDeep)
  if (!isRecord(value)) return value
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    next[key] = removeUndefinedDeep(item)
  }
  return next
}

function projectSkillPaths(config: Record<string, unknown>) {
  const skills = isRecord(config.skills) ? config.skills : {}
  return Array.isArray(skills.paths) ? skills.paths.map(String) : []
}

function setProjectSkillPaths(config: Record<string, unknown>, paths: string[]) {
  const skills = isRecord(config.skills) ? { ...config.skills } : {}
  skills.paths = paths
  config.skills = skills
}

function projectMCPServers(config: Record<string, unknown>) {
  if (config.mcp === undefined) return {}
  if (!isRecord(config.mcp)) throw new MinicodeError("minicode.jsonc mcp must contain an object", { code: "CONFIG_INVALID" })
  return { ...config.mcp }
}

function setProjectMCPServers(config: Record<string, unknown>, servers: Record<string, unknown>) {
  config.mcp = servers
}

async function latestSessionId(runtime: Runtime | RuntimeWithoutLLM) {
  const [latest] = await runtime.sessions.listSessions()
  return latest?.id
}

function formatSkillInstallPlan(plan: SkillInstallPlan) {
  return [
    "Install plan:",
    `skill: ${plan.skill.name} (${plan.skill.id})`,
    `source: ${plan.skill.source}`,
    plan.skill.version ? `version: ${plan.skill.version}` : undefined,
    plan.skill.updatedAt ? `updated: ${plan.skill.updatedAt}` : undefined,
    `target: ${plan.targetDir}`,
    "files:",
    ...plan.files.map((file) => `- ${file.path} (${file.bytes} bytes, sha256 ${file.sha256})`),
    "",
    plan.warning,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatSkillInstallResult(result: SkillInstallResult) {
  return [
    `installed ${result.skill.name} to ${result.targetDir}`,
    `manifest: ${result.manifestPath}`,
    "files:",
    ...result.files.map((file) => `- ${file.path} (${file.bytes} bytes, sha256 ${file.sha256})`),
  ].join("\n")
}

function skillHub(config: MinicodeConfig) {
  const apiKey = config.skillhub.apiKeyEnv ? process.env[config.skillhub.apiKeyEnv] : undefined
  return new SkillHubProvider({ baseURL: config.skillhub.baseURL, ...(apiKey ? { apiKey } : {}) })
}

function parseOutputFormat(value: string | undefined, legacyJson: boolean): OutputFormat {
  if (legacyJson && value === undefined) return "jsonl-legacy"
  if (value === undefined) return "text"
  if (value === "text" || value === "json" || value === "stream-json") return value
  throw new MinicodeError(`Invalid output format: ${value}`, { code: "CLI_USAGE" })
}

function streamInitEvent(
  runtime: Runtime | RuntimeWithoutLLM,
  options: { sessionId?: string; permissionMode: string; outputStyle: string },
) {
  return {
    type: "system",
    subtype: "init",
    uuid: options.sessionId,
    session_id: options.sessionId,
    cwd: runtime.cwd,
    tools: runtime.tools.list().map((tool) => tool.name),
    mcp_servers: Object.keys(runtime.config.mcp).sort((a, b) => a.localeCompare(b)),
    model: runtime.config.model,
    permissionMode: options.permissionMode,
    slash_commands: ["help", "clear", "paste", "tools", "session", "model", "config", "mcp", "skills", "doctor", "exit"],
    output_style: options.outputStyle,
    __timestamp: new Date().toISOString(),
  }
}

function toStreamJsonEvent(event: AgentEvent, sessionId: string | undefined) {
  const base = {
    session_id: sessionId,
    __timestamp: new Date().toISOString(),
  }
  switch (event.type) {
    case "session_created":
      return { ...base, type: "system", subtype: "session", session_id: event.sessionId, uuid: event.sessionId }
    case "llm_text_delta":
      return undefined
    case "tool_call":
      return {
        ...base,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: event.id, name: event.name, input: event.input }],
          stop_reason: "tool_use",
        },
      }
    case "tool_result":
      return {
        ...base,
        type: "user",
        parent_tool_use_id: event.id,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: event.id,
              content: [{ type: "text", text: event.content }],
              is_error: !event.ok,
              metadata: event.metadata,
            },
          ],
        },
      }
    case "message":
      return {
        ...base,
        type: "assistant",
        message: { role: event.role, content: [{ type: "text", text: event.content }], status: "completed" },
      }
    case "error":
      return { ...base, type: "error", is_error: true, error: event.message }
    case "finish":
      return { ...base, type: "system", subtype: "finish", reason: event.reason, session_id: event.sessionId }
  }
}

function resultSummaryEvent(
  events: AgentEvent[],
  options: { sessionId?: string; durationMs: number; finishReason: string; errorMessage: string },
) {
  const finalMessage = [...events].reverse().find((event) => event.type === "message")
  const toolResults = events.filter((event) => event.type === "tool_result")
  const permissionDenials = toolResults
    .filter((event) => !event.ok && /Permission denied/i.test(event.content))
    .map((event) => ({ tool: event.name, content: event.content, metadata: event.metadata }))
  const isError = Boolean(options.errorMessage) || ["error", "max_steps"].includes(options.finishReason)
  return {
    type: "result",
    subtype: isError ? "error" : "success",
    is_error: isError,
    result: finalMessage?.type === "message" ? finalMessage.content : "",
    error: options.errorMessage || undefined,
    session_id: options.sessionId,
    duration_ms: options.durationMs,
    finish_reason: options.finishReason,
    num_turns: events.filter((event) => event.type === "tool_call" || event.type === "message" || event.type === "error").length,
    permission_denials: permissionDenials,
    __timestamp: new Date().toISOString(),
  }
}

function exitCodeForResult(result: ReturnType<typeof resultSummaryEvent>) {
  if (result.permission_denials.length > 0) return 3
  if (result.finish_reason === "max_steps") return 4
  if (result.subtype === "error") return result.error || result.is_error ? 2 : 1
  return 0
}

async function renderChatBanner(
  runtime: Runtime | RuntimeWithoutLLM,
  terminal: ReturnType<typeof createTerminal>,
  permissionMode: string,
  activeSessionId?: string,
) {
  const sessions = await runtime.sessions.listSessions()
  const recent = sessions.slice(0, 3).map((session) => session.title ?? session.id)
  const recentEmpty = sessions.length === 0
  const width = panelWidthForTerminal(terminal.width)
  const dividerColumn = 36
  const panelWidth = panelWidthForTerminal(width)
  const rightWidth = panelWidth - dividerColumn - 5
  const art = [
    "",
    terminal.white("          ████        ████"),
    terminal.white("          ████████████████"),
    terminal.white("        ████            ████"),
    terminal.white("        ████  ██    ██  ████"),
    terminal.white("        ████  ██    ██  ████"),
    terminal.white("        ████            ████"),
    terminal.white("          ████████████████"),
    "",
  ]
  const rows: string[][] = [
    [art[0] ?? "", terminal.blue(terminal.bold("Tips for getting started"))],
    [art[1] ?? "", "Use /paste for multiline input."],
    [art[2] ?? "", "Ctrl-D exits. Ctrl-C cancels or arms exit."],
    [art[3] ?? "", "Press ? or /help for shortcuts."],
    [art[4] ?? "", divider(rightWidth, terminal)],
    [art[5] ?? "", terminal.blue(terminal.bold("Recent activity"))],
    [art[6] ?? "", recent[0] ?? "No recent activity in this cwd"],
    [art[7] ?? "", recent[1] ?? (recentEmpty ? terminal.gray("Run from a project folder to see its sessions.") : "")],
    [art[8] ?? "", recent[2] ?? ""],
    ["", divider(rightWidth, terminal)],
    ["", `${terminal.blue(shortModel(runtime.config.model))} · permission ${permissionMode}`],
    ["", activeSessionId ? `${terminal.gray("session")} ${shortSession(activeSessionId)}` : `${terminal.gray("session")} new`],
    ["", `${terminal.gray("cwd")} ${runtime.cwd}`],
    ["", `${terminal.gray("workspace")} ${runtime.config.sandbox.workspaceDir}`],
  ]
  return panel(`minicode v${VERSION}`, rows, { terminal, width, dividerColumn })
}

function formatToolList(tools: Array<{ name: string; description: string }>) {
  return table([["tool", "description"], ...tools.map((tool) => [tool.name, tool.description])], { header: true })
}

function formatSkillList(skills: Array<{ name: string; description: string; source: { relativePath: string } }>) {
  return table([["skill", "description", "source"], ...skills.map((skill) => [skill.name, skill.description, skill.source.relativePath])], {
    header: true,
  })
}

function formatMCPStatusTable(statuses: Awaited<ReturnType<typeof inspectMCPServers>>) {
  return table(
    [
      ["server", "status", "transport", "tools", "detail"],
      ...statuses.map((status) => [
        status.name,
        status.status,
        status.transport,
        String(status.tools),
        status.status === "failed" ? status.error : status.status === "connected" ? status.toolNames.join(", ") : "",
      ]),
    ],
    { header: true },
  )
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (!isRecord(value)) return value
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    next[key] = isSecretConfigKey(key) ? "[redacted]" : redactConfig(item)
  }
  return next
}

function isSecretConfigKey(key: string) {
  return /^(apiKey|api_key|key|secret|password|accessToken|refreshToken|authToken|bearerToken)$/i.test(key)
}

function readConfigPath(config: unknown, path: string) {
  const parts = path.split(".").filter(Boolean)
  let current = config
  for (const part of parts) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function writeConfigPath(config: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".").filter(Boolean)
  if (!parts.length) throw new MinicodeError("config path is required", { code: "CLI_USAGE" })
  let current: Record<string, unknown> = config
  for (const part of parts.slice(0, -1)) {
    const next = current[part]
    if (isRecord(next)) {
      current = next
      continue
    }
    const created: Record<string, unknown> = {}
    current[part] = created
    current = created
  }
  current[parts[parts.length - 1]!] = value
}

function parseConfigValue(raw: string) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function mcpCommand(args: string[]): Promise<CliResult> {
  const [subcommand, ...rest] = args
  if (subcommand === "add") return mcpAddCommand(rest)
  if (subcommand === "remove") return mcpRemoveCommand(rest)
  if (subcommand === "enable") return mcpSetEnabledCommand(rest, true)
  if (subcommand === "disable") return mcpSetEnabledCommand(rest, false)
  if (subcommand === "doctor") return mcpDoctorCommand(rest)

  const config = await loadConfig()
  if (subcommand === "list" || subcommand === "ls") {
    const statuses = await inspectMCPServers(config)
    if (has(args, "--json")) return { exitCode: 0, output: JSON.stringify({ servers: statuses }, null, 2) }
    return { exitCode: 0, output: formatMCPStatusTable(statuses) }
  }
  if (subcommand === "test") {
    const json = has(rest, "--json")
    const name = stripFlags(rest, ["--json"]).join(" ").trim()
    if (!name) throw new MinicodeError("mcp test requires a name", { code: "CLI_USAGE" })
    const server = config.mcp[name]
    if (!server) throw new MinicodeError(`Unknown MCP server: ${name}`, { code: "MCP_NOT_FOUND" })
    if (server.enabled === false) throw new MinicodeError(`MCP server is disabled: ${name}`, { code: "MCP_DISABLED" })
    const client = createMCPClient(server)
    const tools = await mcpToolsToDefinitions(name, client)
    if ("close" in client) await client.close?.()
    if (json) return { exitCode: 0, output: JSON.stringify({ name, tools }, null, 2) }
    return { exitCode: 0, output: tools.map((tool) => `${tool.name}\t${tool.description}`).join("\n") }
  }
  throw new MinicodeError("mcp requires add, list, test, doctor, enable, disable, or remove", { code: "CLI_USAGE" })
}

async function mcpAddCommand(args: string[]): Promise<CliResult> {
  const [transport, ...rest] = args
  if (transport === "stdio") return mcpAddStdioCommand(rest)
  if (transport === "http") return mcpAddHttpCommand(rest)
  throw new MinicodeError("mcp add requires stdio or http", { code: "CLI_USAGE" })
}

async function mcpAddStdioCommand(args: string[]): Promise<CliResult> {
  const separator = args.indexOf("--")
  if (separator === -1) {
    throw new MinicodeError("mcp add stdio requires -- before the server command", { code: "CLI_USAGE" })
  }
  const optionArgs = args.slice(0, separator)
  const commandArgs = args.slice(separator + 1)
  const json = has(optionArgs, "--json")
  const yes = has(optionArgs, "--yes")
  const envFlag = takeFlagValues(optionArgs, "--env")
  const timeoutFlag = takeMCPTimeout(envFlag.args)
  const nameArgs = stripFlags(timeoutFlag.args, ["--json", "--yes"])
  const name = nameArgs.join(" ").trim()
  if (!name) throw new MinicodeError("mcp add stdio requires a name", { code: "CLI_USAGE" })
  if (commandArgs.length === 0 || !commandArgs[0]) {
    throw new MinicodeError("mcp add stdio requires a command after --", { code: "CLI_USAGE" })
  }
  const server: MinicodeConfig["mcp"][string] = {
    transport: "stdio",
    command: commandArgs[0],
    ...(commandArgs.length > 1 ? { args: commandArgs.slice(1) } : {}),
    ...parseOptionalPairs(envFlag.values, "env", /^[A-Za-z_][A-Za-z0-9_]*$/),
    ...(timeoutFlag.value !== undefined ? { timeoutMs: timeoutFlag.value } : {}),
  }
  return writeMCPServer({ name, server, yes, json })
}

async function mcpAddHttpCommand(args: string[]): Promise<CliResult> {
  const json = has(args, "--json")
  const yes = has(args, "--yes")
  const headerFlag = takeFlagValues(args, "--header")
  const timeoutFlag = takeMCPTimeout(headerFlag.args)
  const positional = stripFlags(timeoutFlag.args, ["--json", "--yes"])
  const [rawName, rawUrl, ...extra] = positional
  if (!rawName || !rawUrl || extra.length > 0) {
    throw new MinicodeError("mcp add http requires <name> <url>", { code: "CLI_USAGE" })
  }
  assertHTTPURL(rawUrl)
  const server: MinicodeConfig["mcp"][string] = {
    transport: "http",
    url: rawUrl,
    ...parseOptionalPairs(headerFlag.values, "header", /^[A-Za-z0-9-]+$/),
    ...(timeoutFlag.value !== undefined ? { timeoutMs: timeoutFlag.value } : {}),
  }
  return writeMCPServer({ name: rawName, server, yes, json })
}

async function writeMCPServer(options: {
  name: string
  server: MinicodeConfig["mcp"][string]
  yes: boolean
  json: boolean
}): Promise<CliResult> {
  const name = safeMCPName(options.name)
  const config = await readProjectConfig()
  const servers = projectMCPServers(config)
  const existed = servers[name] !== undefined
  if (existed && !options.yes) {
    throw new MinicodeError(`MCP server already exists: ${name}. Re-run with --yes to overwrite.`, { code: "MCP_EXISTS" })
  }
  servers[name] = options.server
  setProjectMCPServers(config, servers)
  await writeProjectConfig(config)
  const result = { name, server: options.server, changed: true, overwritten: existed }
  if (options.json) return { exitCode: 0, output: JSON.stringify(result, null, 2) }
  return { exitCode: 0, output: `${existed ? "updated" : "added"} MCP server ${name}` }
}

async function mcpRemoveCommand(args: string[]): Promise<CliResult> {
  const json = has(args, "--json")
  const name = safeMCPName(stripFlags(args, ["--json"]).join(" ").trim())
  const config = await readProjectConfig()
  const servers = projectMCPServers(config)
  if (servers[name] === undefined) throw new MinicodeError(`Unknown MCP server: ${name}`, { code: "MCP_NOT_FOUND" })
  delete servers[name]
  setProjectMCPServers(config, servers)
  await writeProjectConfig(config)
  const result = { name, changed: true }
  if (json) return { exitCode: 0, output: JSON.stringify(result, null, 2) }
  return { exitCode: 0, output: `removed MCP server ${name}` }
}

async function mcpSetEnabledCommand(args: string[], enabled: boolean): Promise<CliResult> {
  const json = has(args, "--json")
  const name = safeMCPName(stripFlags(args, ["--json"]).join(" ").trim())
  const config = await readProjectConfig()
  const servers = projectMCPServers(config)
  const server = servers[name]
  if (!isRecord(server)) throw new MinicodeError(`Unknown MCP server: ${name}`, { code: "MCP_NOT_FOUND" })
  const next = { ...server }
  if (enabled) delete next.enabled
  else next.enabled = false
  servers[name] = next
  setProjectMCPServers(config, servers)
  await writeProjectConfig(config)
  const result = { name, enabled, changed: true }
  if (json) return { exitCode: 0, output: JSON.stringify(result, null, 2) }
  return { exitCode: 0, output: `${enabled ? "enabled" : "disabled"} MCP server ${name}` }
}

async function mcpDoctorCommand(args: string[]): Promise<CliResult> {
  const json = has(args, "--json")
  const config = await loadConfig()
  const servers = await inspectMCPServers(config)
  const summary = {
    configured: servers.length,
    connected: servers.filter((server) => server.status === "connected").length,
    failed: servers.filter((server) => server.status === "failed").length,
    disabled: servers.filter((server) => server.status === "disabled").length,
  }
  const result = { summary, servers }
  const exitCode = summary.failed > 0 ? 1 : 0
  if (json) return { exitCode, output: JSON.stringify(result, null, 2) }
  const lines = [
    "mcp doctor",
    `configured: ${summary.configured}`,
    `connected: ${summary.connected}`,
    `failed: ${summary.failed}`,
    `disabled: ${summary.disabled}`,
    ...servers.filter((server) => server.status === "failed").map((server) => `- ${server.name}: ${server.error}`),
  ]
  return { exitCode, output: lines.join("\n") }
}

function takeMCPTimeout(args: string[]) {
  const long = takeFlagValue(args, "--timeout-ms")
  const short = takeFlagValue(long.args, "--timeout")
  const raw = short.value ?? long.value
  if (raw === undefined) return { value: undefined as number | undefined, args: short.args }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new MinicodeError(`Invalid MCP timeout: ${raw}`, { code: "CLI_USAGE" })
  }
  return { value, args: short.args }
}

function parseOptionalPairs(values: string[], label: "env" | "header", keyPattern: RegExp) {
  if (values.length === 0) return {}
  const parsed: Record<string, string> = {}
  for (const value of values) {
    const equals = value.indexOf("=")
    const key = equals === -1 ? value : value.slice(0, equals)
    const pairValue = equals === -1 ? "" : value.slice(equals + 1)
    if (!key || !keyPattern.test(key)) {
      throw new MinicodeError(`Invalid MCP ${label} pair: ${value}`, { code: "CLI_USAGE" })
    }
    parsed[key] = pairValue
  }
  return label === "env" ? { env: parsed } : { headers: parsed }
}

function safeMCPName(name: string) {
  const value = name.trim()
  if (!value) throw new MinicodeError("MCP server name is required", { code: "CLI_USAGE" })
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new MinicodeError(`Invalid MCP server name: ${name}`, { code: "MCP_INVALID_NAME" })
  }
  return value
}

function assertHTTPURL(value: string, label = "MCP HTTP URL") {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol")
  } catch {
    throw new MinicodeError(`Invalid ${label}: ${value}`, { code: "CLI_USAGE" })
  }
}

export async function runCli(argv = process.argv.slice(2), options: CliOptions = {}): Promise<CliResult> {
  try {
    if (argv.length === 0 || onlyChatOptions(argv)) return await chatCommand(argv)
    if (has(argv, "--help", "-h")) return { exitCode: 0, output: HELP.trimEnd() }
    if (has(argv, "--version", "-v")) return { exitCode: 0, output: VERSION }
    if (has(argv, "-p", "--print")) return await runCommand(stripFlags(argv, ["-p", "--print"]), options)

    const [command, ...args] = argv
    switch (command) {
      case "doctor":
        return await doctor(args)
      case "run":
        return await runCommand(args, options)
      case "chat":
        return await chatCommand(args)
      case "session":
        return await sessionCommand(args)
      case "config":
        return await configCommand(args)
      case "tool":
        return await toolCommand(args)
      case "skill":
        return await skillCommand(args)
      case "mcp":
        return await mcpCommand(args)
      default:
        throw new MinicodeError(`Unknown command: ${command ?? ""}`, { code: "CLI_USAGE" })
    }
  } catch (error) {
    return { exitCode: 1, error: formatCliError(error) }
  }
}

function onlyChatOptions(argv: string[]) {
  const valueFlags = new Set(["--permission-mode", "--session"])
  const flagSet = new Set(["--no-color", "--verbose", "--permission-mode", "--session", "-c", "--continue"])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if ([...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) continue
    if (!flagSet.has(arg)) return false
    if (valueFlags.has(arg)) index += 1
  }
  return argv.length > 0
}

function formatCliError(error: unknown) {
  if (error instanceof MinicodeError && error.code === "PROVIDER_API_KEY_MISSING") {
    return [
      "provider: missing API key",
      "",
      error.message,
      "",
      "Next steps:",
      "- Run `minicode config use <baseURL|alias> <apiKey> [model]` for plug-and-play setup.",
      "- Or run `minicode config use-env <baseURL|alias> <ENV_VAR> [model]` to keep the key in your shell.",
      "- Inside chat, run `/config setup` for an interactive setup flow.",
      "- Validate configuration with `minicode config validate`.",
    ].join("\n")
  }
  return formatError(error)
}

function isMain() {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(entry).href : false
}

if (isMain()) {
  process.stdout.on("error", (error) => {
    if (isRecord(error) && error.code === "EPIPE") process.exit(0)
    throw error
  })
  const result = await runCli(process.argv.slice(2), { stream: true })
  if (result.output) logger.info(result.output)
  if (result.error) logger.error(result.error)
  process.exitCode = result.exitCode
}

import type { AgentEvent } from "../agent/events"
import type { JsonObject, JsonValue } from "../shared/json"
import { redactSecrets } from "../shared/redact"
import { createTerminal, formatBytes, formatDuration, oneLine, stripAnsi, type Terminal } from "./terminal"

type Writer = (text: string) => void

type ActiveTool = {
  name: string
  input: JsonObject
  startedAt: number
}

export type CliTraceRendererOptions = {
  write: Writer
  now?: () => number
  noColor?: boolean
  verbose?: boolean
  terminal?: Terminal
  style?: "compact" | "codebuddy"
}

export class CliTraceRenderer {
  private readonly writeChunk: Writer
  private readonly now: () => number
  private readonly verbose: boolean
  private readonly terminal: Terminal
  private readonly style: "compact" | "codebuddy"
  private readonly activeTools = new Map<string, ActiveTool>()
  private printedTrace = false
  private answerStarted = false

  constructor(options: CliTraceRendererOptions) {
    this.writeChunk = options.write
    this.now = options.now ?? Date.now
    this.verbose = options.verbose ?? false
    this.style = options.style ?? "compact"
    this.terminal = options.terminal ?? createTerminal({ ...(options.noColor !== undefined ? { noColor: options.noColor } : {}) })
  }

  handle(event: AgentEvent) {
    switch (event.type) {
      case "tool_call":
        this.toolCall(event)
        return
      case "tool_result":
        this.toolResult(event)
        return
      case "llm_text_delta":
        this.textDelta(event.text)
        return
      case "error":
        this.error(event.message)
        return
      default:
        return
    }
  }

  finish() {
    if (this.answerStarted) this.write("\n")
  }

  private toolCall(event: Extract<AgentEvent, { type: "tool_call" }>) {
    const input = objectValue(event.input)
    this.activeTools.set(event.id, { name: event.name, input, startedAt: this.now() })
    if (this.style === "codebuddy") {
      this.writeTrace(`${this.terminal.blue("●")} ${formatToolCall(event.name, input, this.terminal)}\n`)
      return
    }
    this.writeTrace(`${this.terminal.dim("tool")} ${formatToolCall(event.name, input, this.terminal)}\n`)
  }

  private toolResult(event: Extract<AgentEvent, { type: "tool_result" }>) {
    const active = this.activeTools.get(event.id)
    if (active) this.activeTools.delete(event.id)

    const elapsedMs = active ? Math.max(0, this.now() - active.startedAt) : undefined
    const metadata = objectValue(event.metadata)
    const line = formatToolResult(event, metadata, elapsedMs, this.terminal)
    if (this.style === "codebuddy") {
      this.writeTrace(`  ${this.terminal.gray("⎿")} ${line}\n`)
    } else {
      this.writeTrace(`  ${line}\n`)
    }

    if (!event.ok || this.verbose) {
      const preview = previewOutput(event.content)
      if (preview) {
        for (const line of preview.split("\n")) {
          const marker = this.style === "codebuddy" ? "  " : "|"
          this.writeTrace(`  ${this.terminal.gray(marker)} ${line}\n`)
        }
      }
    }
  }

  private textDelta(text: string) {
    if (!this.answerStarted) {
      if (this.printedTrace) this.write("\n")
      this.answerStarted = true
    }
    this.write(text)
  }

  private error(message: string) {
    if (this.answerStarted) this.write("\n")
    this.writeTrace(`${this.terminal.red("error")} ${oneLine(message, 240)}\n`)
  }

  private writeTrace(text: string) {
    if (this.answerStarted) this.write("\n")
    this.answerStarted = false
    this.printedTrace = true
    this.write(text)
  }

  private write(text: string) {
    this.writeChunk(redactSecrets(text))
  }
}

function objectValue(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value
}

function stringValue(input: JsonObject, key: string) {
  const value = input[key]
  return typeof value === "string" ? value : ""
}

function numberValue(input: JsonObject, key: string) {
  const value = input[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(input: JsonObject, key: string) {
  const value = input[key]
  return typeof value === "boolean" ? value : undefined
}

function formatToolCall(name: string, input: JsonObject, terminal: Terminal) {
  const label = (value: string) => terminal.blue(value)
  const targetWidth = (reserved = 14) => Math.max(24, Math.min(180, terminal.width - reserved))
  switch (name) {
    case "shell":
      return `${label("bash")} ${oneLine(stringValue(input, "command") || "(empty command)", targetWidth())}`
    case "read":
      return `${label("read")} ${oneLine(stringValue(input, "path") || "(missing path)", targetWidth())}`
    case "grep": {
      const query = quote(stringValue(input, "query"))
      const path = stringValue(input, "path")
      return `${label("grep")} ${query}${path ? ` in ${oneLine(path, targetWidth(40))}` : ""}`
    }
    case "glob": {
      const pattern = quote(stringValue(input, "pattern"))
      const cwd = stringValue(input, "cwd")
      return `${label("glob")} ${pattern}${cwd ? ` in ${oneLine(cwd, targetWidth(40))}` : ""}`
    }
    case "write":
      return `${label("write")} ${oneLine(stringValue(input, "path") || "(missing path)", targetWidth())}`
    case "edit":
      return `${label("edit")} ${oneLine(stringValue(input, "path") || "(missing path)", targetWidth())}`
    case "patch":
      return `${label("patch")} ${oneLine(stringValue(input, "path") || "(missing path)", targetWidth())}`
    case "todo":
      return label("todo")
    case "skill":
      return `${label("skill")} ${quote(stringValue(input, "name"))}${stringValue(input, "path") ? ` ${quote(stringValue(input, "path"))}` : ""}`
    case "skillhub_search":
      return `${label("skillhub search")} ${quote(stringValue(input, "query"))}`
    case "skillhub_install":
      return `${label("skillhub install")} ${quote(stringValue(input, "id"))}`
    default:
      return `${label(name)}${inputSummary(input)}`
  }
}

function formatToolResult(
  event: Extract<AgentEvent, { type: "tool_result" }>,
  metadata: JsonObject,
  elapsedMs: number | undefined,
  terminal: Terminal,
) {
  const parts = [event.ok ? terminal.green("ok") : terminal.red("fail")]
  const exitCode = numberValue(metadata, "exitCode")
  const timedOut = booleanValue(metadata, "timedOut")
  if (exitCode !== undefined) parts.push(`exit=${exitCode}`)
  if (timedOut) parts.push("timeout")
  if (elapsedMs !== undefined) parts.push(formatDuration(elapsedMs))
  parts.push(formatBytes(Buffer.byteLength(event.content)))
  return parts.join(" ")
}

function inputSummary(input: JsonObject) {
  const values = Object.entries(input)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 3)
    .map(([key, value]) => `${key}=${oneLine(String(value), 60)}`)
  return values.length ? ` [${values.join(", ")}]` : ""
}

function quote(value: string) {
  return `"${oneLine(value, 120).replaceAll("\"", "\\\"")}"`
}

function previewOutput(content: string) {
  const lines = stripAnsi(content)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^exitCode:\s*/.test(line) && !/^timedOut:\s*/.test(line))
    .map((line) => oneLine(line, 180))
    .filter(Boolean)
    .slice(0, 3)
  return lines.join("\n")
}

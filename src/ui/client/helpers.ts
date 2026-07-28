import type { KeyboardEvent } from "react"

import type { AgentEvent } from "../../agent/events"
import type { SessionEvidence } from "../../session/evidence"
import type { MessagePart, SessionMessage, SessionTurn } from "../../session/types"
import { ENDPOINTS } from "./constants"
import type { ChatMessage, FileReference, FileReferenceSource, TraceItem, TurnArtifact, TurnTool } from "./types"

export function sessionMessages(messages: SessionMessage[], evidence?: SessionEvidence, turns: SessionTurn[] = []) {
  const result: ChatMessage[] = []
  let assistant: ChatMessage | undefined
  const artifactsByMessage = turnArtifactsByMessage(evidence)
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]))

  function ensureAssistant(seed: SessionMessage): ChatMessage {
    if (!assistant) {
      const turn = seed.turnId ? turnsById.get(seed.turnId) : undefined
      assistant = {
        id: `turn_${seed.id}`,
        ...(seed.turnId ? { turnId: seed.turnId } : {}),
        ...(turn ? { turn } : {}),
        role: "assistant",
        text: "",
        createdAt: seed.createdAt,
        parts: [],
        tools: [],
        artifacts: [],
      }
    }
    return assistant
  }

  function flushAssistant() {
    if (!assistant) return
    if (assistant.text || assistant.tools?.length || assistant.artifacts?.length) result.push(assistant)
    assistant = undefined
  }

  for (const message of messages) {
    if (message.role === "system") continue
    if (message.role === "user") {
      flushAssistant()
      const parsed = splitFileReferences(textFromParts(message.parts))
      const structured = message.parts
        .filter((part): part is Extract<MessagePart, { type: "file_reference" }> => part.type === "file_reference")
        .map((part) => ({
          path: part.path,
          name: fileNameFromPath(part.path),
          source: part.source ?? "workspace",
          status: part.source === "uploaded" ? "uploaded" as const : "referenced" as const,
          ...(part.startLine !== undefined ? { startLine: part.startLine } : {}),
          ...(part.endLine !== undefined ? { endLine: part.endLine } : {}),
        }))
      const attachments = uniqueFileReferences([...parsed.attachments, ...structured])
      result.push({
        id: message.id,
        ...(message.turnId ? { turnId: message.turnId } : {}),
        role: "user",
        text: parsed.text,
        createdAt: message.createdAt,
        parts: message.parts.filter((part) => part.type !== "file_reference"),
        ...(attachments.length ? { attachments } : {}),
      })
      continue
    }

    const target = ensureAssistant(message)
    target.parts = [...(target.parts ?? []), ...message.parts]
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        target.text = [target.text, part.text.trim()].filter(Boolean).join("\n\n")
      }
      if (part.type === "tool_call") {
        target.tools = upsertTurnTool(target.tools ?? [], {
          id: part.id,
          name: part.name,
          status: "running",
          detail: JSON.stringify(part.input, null, 2),
        })
      }
      if (part.type === "tool_result") {
        const value = asToolResult(part)
        target.tools = upsertTurnTool(target.tools ?? [], {
          id: part.toolCallId,
          name: part.name,
          status: value.ok === false ? "failed" : "success",
          detail: toolResultDetail(part.result),
        })
      }
      if (part.type === "error") {
        target.text = [target.text, `Error: ${part.message}`].filter(Boolean).join("\n\n")
      }
    }
    const turnArtifacts = artifactsByMessage.get(message.id)
    if (turnArtifacts?.length) target.artifacts = uniqueTurnArtifacts([...(target.artifacts ?? []), ...turnArtifacts])
  }
  flushAssistant()
  return result
}

export function splitFileReferences(text: string): { text: string; attachments: FileReference[] } {
  const match = text.match(/(?:^|\n\n)Referenced files:\n((?:- .+(?:\n|$))*)$/)
  if (!match || match.index === undefined) return { text, attachments: [] }
  const block = match[1]
  if (!block) return { text, attachments: [] }
  const attachments: FileReference[] = []
  for (const line of block.trim().split(/\r?\n/)) {
    const item = line.match(/^- (.+) \((uploaded|workspace|generated|evidence)\)$/)
    if (!item?.[1] || !item[2]) return { text, attachments: [] }
    const spec = item[1]
    const range = spec.match(/^(.*):(\d+)-(\d+)$/)
    const path = range?.[1] ?? spec
    const startLine = range?.[2] ? Number(range[2]) : undefined
    const endLine = range?.[3] ? Number(range[3]) : undefined
    attachments.push({
      path,
      name: fileNameFromPath(path),
      source: item[2] as FileReferenceSource,
      status: item[2] === "uploaded" ? "uploaded" : "referenced",
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    })
  }
  return { text: text.slice(0, match.index).trim(), attachments }
}

function uniqueFileReferences(items: FileReference[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.source}:${item.path}:${item.startLine ?? ""}:${item.endLine ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function turnArtifactsByMessage(evidence: SessionEvidence | undefined) {
  const result = new Map<string, TurnArtifact[]>()
  if (!evidence) return result
  for (const artifact of evidence.artifacts) {
    const current = result.get(artifact.messageId) ?? []
    current.push({ kind: "artifact", tool: artifact.tool, label: artifact.path, path: artifact.path })
    result.set(artifact.messageId, current)
  }
  for (const source of evidence.sources) {
    const current = result.get(source.messageId) ?? []
    current.push({
      kind: "source",
      tool: source.tool,
      label: source.title ?? source.url ?? source.query ?? "Source",
      ...(source.url ? { url: source.url } : {}),
    })
    result.set(source.messageId, current)
  }
  return result
}

function uniqueTurnArtifacts(items: TurnArtifact[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.kind}:${item.path ?? item.url ?? item.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function upsertTurnTool(items: TurnTool[], next: TurnTool) {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) return [...items, next]
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item)
}

function toolResultDetail(value: Extract<MessagePart, { type: "tool_result" }>["result"]) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

export function traceFromMessages(messages: SessionMessage[]): TraceItem[] {
  const items: TraceItem[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") items.push({ id: part.id, title: `tool ${part.name}`, detail: JSON.stringify(part.input, null, 2), kind: "call" })
      if (part.type === "tool_result") {
        const result = asToolResult(part)
        items.push({ id: part.toolCallId, title: `${result.ok === false ? "failed" : "ok"} ${part.name}`, detail: JSON.stringify(part.result, null, 2), kind: "result", failed: result.ok === false })
      }
      if (part.type === "error") items.push({ id: message.id, title: "agent error", detail: part.message, failed: true })
    }
  }
  return items.reverse()
}

function asToolResult(part: Extract<MessagePart, { type: "tool_result" }>) {
  return part.result && typeof part.result === "object" && !Array.isArray(part.result) ? (part.result as { ok?: boolean }) : {}
}

export function textFromParts(parts: MessagePart[]) {
  return parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

export function maybeSend(event: KeyboardEvent<HTMLTextAreaElement>, send: () => Promise<void>) {
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault()
    return send()
  }
  return undefined
}

export function isNearScrollEnd(input: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = 96) {
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold
}

export function presetForBaseURL(value: string | undefined): keyof typeof ENDPOINTS | "custom" {
  const normalized = String(value ?? "").replace(/\/+$/, "")
  for (const [key, endpoint] of Object.entries(ENDPOINTS)) {
    if (endpoint === normalized) return key as keyof typeof ENDPOINTS
  }
  return "custom"
}

export function shortDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function pathBasename(value: string | undefined) {
  const normalized = String(value ?? "").replace(/[\\/]+$/, "")
  if (!normalized) return ""
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? normalized
}

export function fileNameFromPath(value: string) {
  return pathBasename(value) || value
}

export function isPreviewUnsupported(path: string, kind?: "text" | "binary") {
  return kind === "binary" || /\.pdf$/i.test(path)
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type RunResultLike = {
  answer?: string
  status?: unknown
  finishReason?: string
  error?: string
}

export function failureMessageFromAgentEvent(event: AgentEvent) {
  if (event.type === "error") return compactFailureDetail(event.message)
  if (event.type !== "tool_result" || event.ok) return undefined
  const detail = compactFailureDetail(event.content)
  return detail.includes("\n")
    ? `${event.name} failed:\n${detail}`
    : `${event.name} failed${detail ? `: ${detail}` : ""}`
}

export function assistantTextFromRunResult(result: RunResultLike, fallbackFailure?: string) {
  if (typeof result.answer === "string" && result.answer.trim()) return result.answer
  if (result.status === "error") return `Error: ${result.error || fallbackFailure || "Run failed."}`
  if (result.status === "cancelled") return "Cancelled."
  if (result.finishReason === "error" && fallbackFailure) return `Error: ${fallbackFailure}`
  return "(no answer)"
}

export function streamDisconnectMessage(fallbackFailure?: string) {
  return (
    fallbackFailure ||
    "与运行事件流的连接中断，且多次重连未恢复。任务可能仍在后台完成——请查看右侧 Activity 面板了解最后执行的步骤，或稍后重新打开该会话。"
  )
}

export function staleRunMessage(fallbackFailure?: string) {
  return fallbackFailure || "Run stopped because the local Pixiu service restarted. Send a new message to continue."
}

export function failureMessageFromRunErrorEvent(event: Event) {
  const data = event instanceof MessageEvent ? event.data : (event as { data?: unknown }).data
  if (typeof data !== "string" || !data.trim()) return undefined
  try {
    const parsed = JSON.parse(data) as { message?: unknown }
    return typeof parsed.message === "string" ? compactFailureDetail(parsed.message) : undefined
  } catch {
    return compactFailureDetail(data)
  }
}

function compactFailureDetail(value: string) {
  const text = value.replace(/\r\n?/g, "\n").trim()
  if (text.length <= 1200) return text
  return `${text.slice(0, 1200).trimEnd()}...`
}

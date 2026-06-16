import type { KeyboardEvent } from "react"

import type { MessagePart, SessionMessage } from "../../session/types"
import { ENDPOINTS } from "./constants"
import type { TraceItem } from "./types"

export function sessionMessages(messages: SessionMessage[]) {
  const result: Array<{ role: "user" | "assistant"; text: string }> = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue
    const text = textFromParts(message.parts)
    if (text) result.push({ role: message.role, text })
  }
  return result
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
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    return send()
  }
  return undefined
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

import type { JsonObject, JsonValue } from "../shared/json"
import type { SessionMessage } from "./types"

export type SessionEvidence = {
  artifacts: Array<{ tool: string; path: string; sessionId: string; messageId: string; createdAt: string; exists?: boolean }>
  sources: Array<{ tool: string; sessionId: string; url?: string; query?: string; title?: string; accessedAt?: string; messageId: string }>
  shellCommands: Array<{ command: string; sessionId: string; exitCode?: number; messageId: string; createdAt: string }>
}

export function collectSessionEvidence(messages: SessionMessage[]): SessionEvidence {
  const artifacts: SessionEvidence["artifacts"] = []
  const sources: SessionEvidence["sources"] = []
  const shellCommands: SessionEvidence["shellCommands"] = []

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue
      const result = asObject(part.result)
      const metadata = asObject(result.metadata)
      const path = stringValue(metadata.path)
      if (path && ["write", "edit", "patch"].includes(part.name)) {
        artifacts.push({ tool: part.name, path, sessionId: message.sessionId, messageId: message.id, createdAt: message.createdAt })
      }

      if (part.name === "web_fetch" || metadata.kind === "web_fetch") {
        const url = stringValue(metadata.url)
        const title = stringValue(metadata.title)
        const accessedAt = stringValue(metadata.accessedAt)
        sources.push({
          tool: part.name,
          sessionId: message.sessionId,
          messageId: message.id,
          ...(url ? { url } : {}),
          ...(title ? { title } : {}),
          ...(accessedAt ? { accessedAt } : {}),
        })
      }

      if (part.name === "web_search" || metadata.kind === "web_search") {
        const query = stringValue(metadata.query)
        const url = stringValue(metadata.searchURL)
        const accessedAt = stringValue(metadata.accessedAt)
        sources.push({
          tool: part.name,
          sessionId: message.sessionId,
          messageId: message.id,
          ...(query ? { query } : {}),
          ...(url ? { url } : {}),
          ...(accessedAt ? { accessedAt } : {}),
        })
      }

      const command = stringValue(metadata.command)
      if (part.name === "shell" && command) {
        const exitCode = numberValue(metadata.exitCode)
        shellCommands.push({
          command,
          sessionId: message.sessionId,
          messageId: message.id,
          createdAt: message.createdAt,
          ...(exitCode !== undefined ? { exitCode } : {}),
        })
      }
    }
  }

  return { artifacts: uniqueArtifacts(artifacts), sources: uniqueSources(sources), shellCommands }
}

function asObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function stringValue(value: JsonValue | undefined) {
  return typeof value === "string" && value ? value : undefined
}

function numberValue(value: JsonValue | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function uniqueArtifacts(items: SessionEvidence["artifacts"]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.tool}:${item.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueSources(items: SessionEvidence["sources"]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.tool}:${item.url ?? ""}:${item.query ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

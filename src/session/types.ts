import type { JsonObject, JsonValue } from "../shared/json"

export type MessageRole = "system" | "user" | "assistant" | "tool"

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; input: JsonObject }
  | { type: "tool_result"; toolCallId: string; name: string; result: JsonValue }
  | { type: "error"; message: string; code?: string }

export type SessionMessage = {
  id: string
  sessionId: string
  role: MessageRole
  createdAt: string
  parts: MessagePart[]
}

export type SessionRecord = {
  id: string
  cwd: string
  createdAt: string
  updatedAt: string
  title?: string
  summary?: string
  metadata?: JsonObject
}

export type CreateSessionInput = {
  id?: string
  cwd: string
  title?: string
  metadata?: JsonObject
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionRecord>
  appendMessage(message: Omit<SessionMessage, "id" | "createdAt"> & Partial<Pick<SessionMessage, "id" | "createdAt">>): Promise<SessionMessage>
  getSession(id: string): Promise<SessionRecord | undefined>
  readMessages(sessionId: string): Promise<SessionMessage[]>
  listSessions(): Promise<SessionRecord[]>
  updateSession(sessionId: string, patch: Partial<Pick<SessionRecord, "title" | "summary" | "metadata">>): Promise<SessionRecord>
}

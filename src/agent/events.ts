import type { JsonValue } from "../shared/json"

export type AgentEvent =
  | { type: "session_created"; sessionId: string }
  | { type: "llm_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: JsonValue }
  | { type: "tool_result"; id: string; name: string; ok: boolean; content: string; metadata?: JsonValue }
  | { type: "message"; role: "assistant"; content: string }
  | { type: "error"; message: string }
  | { type: "finish"; reason: string; sessionId: string }

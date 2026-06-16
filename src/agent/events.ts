import type { JsonValue } from "../shared/json"
import type { TodoItem } from "../todo/types"

export type AgentEvent =
  | { type: "session_created"; sessionId: string }
  | { type: "context_usage"; inputTokens: number; outputTokens?: number; source: "estimated" | "provider" }
  | { type: "assistant_progress_delta"; text: string }
  | { type: "llm_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: JsonValue }
  | { type: "tool_result"; id: string; name: string; ok: boolean; content: string; metadata?: JsonValue }
  | { type: "todo_updated"; sessionId: string; todos: TodoItem[]; currentTodoId?: string }
  | { type: "message"; role: "assistant"; content: string }
  | { type: "error"; message: string }
  | { type: "finish"; reason: string; sessionId: string }

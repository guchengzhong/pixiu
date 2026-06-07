import type { JsonObject, JsonValue } from "../shared/json"

export type JSONSchema = {
  type?: "object" | "string" | "number" | "boolean" | "array"
  description?: string
  properties?: Record<string, JSONSchema>
  items?: JSONSchema
  required?: string[]
  enum?: JsonValue[]
  additionalProperties?: boolean | JSONSchema
}

export type LLMRole = "system" | "user" | "assistant" | "tool"

export type LLMToolCall = {
  id: string
  name: string
  input: JsonObject
}

export type LLMMessage = {
  role: LLMRole
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: LLMToolCall[]
}

export type LLMToolDefinition = {
  name: string
  description: string
  inputSchema: JSONSchema
}

export type LLMStreamInput = {
  model: string
  messages: LLMMessage[]
  tools?: LLMToolDefinition[]
  toolChoice?: "auto" | "none" | { name: string }
  temperature?: number
}

export type LLMStreamEvent =
  | { type: "text_start" }
  | { type: "text_delta"; text: string }
  | { type: "text_end"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; call: LLMToolCall }
  | { type: "tool_result"; toolCallId: string; result: JsonValue }
  | { type: "finish"; reason?: string }
  | { type: "error"; error: string; code?: string }

export interface LLMClient {
  stream(input: LLMStreamInput, signal?: AbortSignal): AsyncIterable<LLMStreamEvent>
}

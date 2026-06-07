import type { PermissionManager } from "../permission/types"
import type { PathGuard } from "../sandbox/path"
import type { JsonObject, JsonValue } from "../shared/json"
import type { JSONSchema, LLMToolDefinition } from "../llm/types"

export type ToolResult = {
  ok: boolean
  content: string
  data?: JsonValue
  metadata?: JsonObject
}

export type ToolContext = {
  cwd: string
  workspaceRoot: string
  sessionId?: string
  signal?: AbortSignal
  permissions: PermissionManager
  pathGuard: PathGuard
  config: {
    shellTimeoutMs: number
    outputMaxBytes: number
    envAllowlist: string[]
  }
}

export type ToolDefinition = LLMToolDefinition & {
  risk?: "low" | "medium" | "high"
  execute(input: JsonObject, context: ToolContext): Promise<ToolResult>
}

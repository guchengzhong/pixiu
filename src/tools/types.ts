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

// ToolDefinition extends the LLMToolDefinition with an optional risk level 
// and an execute function that takes the tool input and context, and returns 
// a promise of the tool result. The execute function is where the actual logic 
// of the tool is implemented, and it can use the context to access the current 
// working directory, workspace root, session ID, permissions, path guard, and 
// other configuration options.
export type ToolDefinition = LLMToolDefinition & {
  risk?: "low" | "medium" | "high"
  execute(input: JsonObject, context: ToolContext): Promise<ToolResult>
}

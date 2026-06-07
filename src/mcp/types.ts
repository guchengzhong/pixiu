import type { JSONSchema } from "../llm/types"
import type { JsonObject, JsonValue } from "../shared/json"

export type MCPTool = {
  name: string
  description?: string
  inputSchema?: JSONSchema
}

export type MCPServerStatus =
  | {
      name: string
      transport: "stdio" | "http"
      status: "connected"
      tools: number
      toolNames: string[]
    }
  | {
      name: string
      transport: "stdio" | "http"
      status: "failed"
      tools: 0
      error: string
    }
  | {
      name: string
      transport: "stdio" | "http"
      status: "disabled"
      tools: 0
    }

export interface MCPClient {
  listTools(): Promise<MCPTool[]>
  callTool(name: string, input: JsonObject): Promise<JsonValue>
  close?(): Promise<void>
}

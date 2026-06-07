import type { MCPClient } from "./types"
import type { JSONSchema } from "../llm/types"
import { MinicodeError } from "../shared/errors"
import type { ToolDefinition } from "../tools/types"

export async function mcpToolsToDefinitions(prefix: string, client: MCPClient): Promise<ToolDefinition[]> {
  const tools = await client.listTools()
  const names = new Map<string, string>()
  return tools.map((tool) => {
    const name = mcpToolDefinitionName(prefix, tool.name)
    const prior = names.get(name)
    if (prior) {
      throw new MinicodeError(`Duplicate MCP tool name after sanitization: ${name} (${prior}, ${tool.name})`, { code: "MCP_TOOL_DUPLICATE" })
    }
    names.set(name, tool.name)
    return {
      name,
      description: tool.description ?? `MCP tool ${tool.name}`,
      risk: "medium",
      inputSchema: normalizeMCPInputSchema(tool.inputSchema),
      async execute(input) {
        try {
          const result = await client.callTool(tool.name, input)
          return {
            ok: true,
            content: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            data: result,
            metadata: { mcpTool: tool.name, mcpPrefix: prefix, mcpImportedName: name },
          }
        } catch (error) {
          return { ok: false, content: error instanceof Error ? error.message : String(error) }
        }
      },
    } satisfies ToolDefinition
  })
}

export function mcpToolDefinitionName(prefix: string, toolName: string) {
  return `${sanitizeToolSegment(prefix)}.${sanitizeToolSegment(toolName)}`
}

export function sanitizeToolSegment(value: string) {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return safe || "mcp"
}

export function normalizeMCPInputSchema(schema: JSONSchema | undefined): JSONSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} }
  const raw = schema as Record<string, unknown>
  const properties = raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties) ? raw.properties : {}
  return {
    ...schema,
    type: "object",
    properties,
  } as JSONSchema
}

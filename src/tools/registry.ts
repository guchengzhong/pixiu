import { PixiuError, formatError } from "../shared/errors"
import type { JsonObject } from "../shared/json"
import { classifyShellCommand } from "../sandbox/shell"
import { validateToolInput } from "./schema"
import type { ToolContext, ToolDefinition, ToolResult } from "./types"
import type { JSONSchema } from "../llm/types"

const ACTIVITY_INTENT_SCHEMA: JSONSchema = {
  type: "object",
  description: "Optional Pixiu-only user-visible intent for this tool call. The runtime strips it before executing the tool.",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      description: "Activity category.",
      enum: ["tool", "file", "shell", "search", "skill", "permission", "artifact", "system", "other"],
    },
    title: {
      type: "string",
      description: "Concise intent title, describing why the tool is being used rather than the raw command.",
    },
    summary: {
      type: "string",
      description: "Short factual user-visible summary.",
    },
    target: {
      type: "string",
      description: "Primary target such as a file path, city, URL, package, or artifact.",
    },
    command: {
      type: "string",
      description: "Command only when it is useful as supporting detail.",
    },
    details: {
      type: "object",
      description: "Small structured details safe to show in the UI. Do not include secrets or large output.",
      additionalProperties: true,
    },
  },
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) throw new PixiuError(`Duplicate tool: ${tool.name}`, { code: "TOOL_DUPLICATE" })
    this.tools.set(tool.name, tool)
    return this
  }

  registerMany(tools: ToolDefinition[]) {
    for (const tool of tools) this.register(tool)
    return this
  }

  get(name: string) {
    return this.tools.get(name)
  }

  list() {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  toLLMTools(names?: string[]) {
    const selected = names ? names.map((name) => this.get(name)).filter((tool): tool is ToolDefinition => Boolean(tool)) : this.list()
    return selected.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: withActivityIntentSchema(inputSchema),
    }))
  }

  async execute(name: string, input: JsonObject, context: ToolContext): Promise<ToolResult> {
    const tool = this.get(name)
    if (!tool) {
      return {
        ok: false,
        content: `Unknown tool: ${name}. Available tools: ${this.list()
          .map((item) => item.name)
          .join(", ")}`,
      }
    }
    try {
      validateToolInput(tool.inputSchema, input, name)
      const shellRisk = name === "shell" && typeof input.command === "string" ? classifyShellCommand(input.command) : undefined
      const request = {
        tool: name,
        input,
        cwd: context.cwd,
        ...(shellRisk ? { risk: shellRisk.risk, reason: shellRisk.reason } : tool.risk ? { risk: tool.risk } : {}),
      }
      const decision = await context.permissions.check(request)
      const permissionMetadata = {
        permissionAction: decision.action,
        permissionReason: decision.reason,
        ...(decision.originalAction ? { permissionOriginalAction: decision.originalAction } : {}),
        ...(decision.rule ? { permissionRule: decision.rule } : {}),
        ...(shellRisk
          ? {
              shellRisk: shellRisk.risk,
              shellRiskCategory: shellRisk.category,
              shellRiskReason: shellRisk.reason,
            }
          : {}),
      }
      if (decision.action === "deny") {
        return {
          ok: false,
          content: `Permission denied for ${name}: ${decision.reason}`,
          metadata: permissionMetadata,
        }
      }
      const result = await tool.execute(input, context)
      return {
        ...result,
        metadata: { ...permissionMetadata, ...(result.metadata ?? {}) },
      }
    } catch (error) {
      return { ok: false, content: formatError(error) }
    }
  }
}

function withActivityIntentSchema(schema: JSONSchema): JSONSchema {
  if (schema.type !== "object" && !schema.properties) return schema
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      _activity: ACTIVITY_INTENT_SCHEMA,
    },
  }
}

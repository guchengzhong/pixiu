import { MinicodeError, formatError } from "../shared/errors"
import type { JsonObject } from "../shared/json"
import { classifyShellCommand } from "../sandbox/shell"
import { validateToolInput } from "./schema"
import type { ToolContext, ToolDefinition, ToolResult } from "./types"

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) throw new MinicodeError(`Duplicate tool: ${tool.name}`, { code: "TOOL_DUPLICATE" })
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
    return selected.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
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

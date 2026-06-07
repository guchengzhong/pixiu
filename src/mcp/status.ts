import type { MinicodeConfig } from "../config/defaults"
import { formatError } from "../shared/errors"
import { HttpMCPClient, StdioMCPClient } from "./client"
import type { MCPClient, MCPServerStatus } from "./types"

export type MCPServerConfig = MinicodeConfig["mcp"][string]

export function createMCPClient(server: MCPServerConfig): MCPClient {
  return server.transport === "stdio"
    ? new StdioMCPClient({
        command: server.command!,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
      })
    : new HttpMCPClient({
        url: server.url!,
        ...(server.headers ? { headers: server.headers } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
      })
}

export async function inspectMCPServer(name: string, server: MCPServerConfig): Promise<MCPServerStatus> {
  const transport = server.transport
  if (server.enabled === false) return { name, transport, status: "disabled", tools: 0 }
  const client = createMCPClient(server)
  try {
    const tools = await client.listTools()
    return {
      name,
      transport,
      status: "connected",
      tools: tools.length,
      toolNames: tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
    }
  } catch (error) {
    return { name, transport, status: "failed", tools: 0, error: oneLine(formatError(error), 240) }
  } finally {
    await client.close?.().catch(() => undefined)
  }
}

export async function inspectMCPServers(config: MinicodeConfig) {
  const entries = Object.entries(config.mcp).sort(([a], [b]) => a.localeCompare(b))
  return Promise.all(entries.map(([name, server]) => inspectMCPServer(name, server)))
}

export function formatMCPStatus(status: MCPServerStatus) {
  const parts = [status.name, status.status, status.transport, `tools=${status.tools}`]
  if (status.status === "failed") parts.push(status.error)
  return parts.join("\t")
}

function oneLine(value: string, maxChars: number) {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

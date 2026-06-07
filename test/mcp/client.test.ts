import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { HttpMCPClient, StdioMCPClient } from "../../src/mcp/client"
import { mcpToolsToDefinitions } from "../../src/mcp/tools"

describe("MCP client", () => {
  test("lists and calls fake stdio MCP tools", async () => {
    const client = new StdioMCPClient({
      command: process.execPath,
      args: [join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")],
      timeoutMs: 2_000,
    })
    try {
      const tools = await mcpToolsToDefinitions("fake", client)
      expect(tools[0]?.name).toBe("fake.echo")
      const result = await tools[0]!.execute({ text: "hi" }, {} as any)
      expect(result.content).toContain("hi")
    } finally {
      await client.close()
    }
  })

  test("lists fake HTTP MCP tools", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body: any = await request.json()
        if (body.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ping", description: "Ping" }] } })
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } })
      },
    })
    try {
      const client = new HttpMCPClient({ url: `http://127.0.0.1:${server.port}` })
      const tools = await mcpToolsToDefinitions("remote", client)
      expect(tools[0]?.name).toBe("remote.ping")
      expect(tools[0]?.inputSchema).toEqual({ type: "object", properties: {} })
    } finally {
      server.stop(true)
    }
  })

  test("surfaces stdio MCP timeout errors", async () => {
    const client = new StdioMCPClient({
      command: process.execPath,
      args: [join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")],
      env: { MINICODE_FAKE_MCP_MODE: "hang" },
      timeoutMs: 50,
    })
    try {
      await expect(client.listTools()).rejects.toThrow("MCP request timed out")
    } finally {
      await client.close()
    }
  })

  test("includes stderr summary when stdio MCP exits", async () => {
    const client = new StdioMCPClient({
      command: process.execPath,
      args: [join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")],
      env: { MINICODE_FAKE_MCP_MODE: "stderr-exit" },
      timeoutMs: 500,
    })
    try {
      await expect(client.listTools()).rejects.toThrow("fake mcp boom stderr")
    } finally {
      await client.close()
    }
  })

  test("detects sanitized MCP tool name collisions", async () => {
    const client = new StdioMCPClient({
      command: process.execPath,
      args: [join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")],
      env: { MINICODE_FAKE_MCP_MODE: "collision" },
      timeoutMs: 2_000,
    })
    try {
      await expect(mcpToolsToDefinitions("fake", client)).rejects.toThrow("Duplicate MCP tool name")
    } finally {
      await client.close()
    }
  })
})

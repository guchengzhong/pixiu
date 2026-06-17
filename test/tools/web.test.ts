import { afterEach, describe, expect, test } from "bun:test"

import { createWebTools } from "../../src/tools/web"
import { StaticPermissionManager } from "../../src/permission/evaluator"
import { PathGuard } from "../../src/sandbox/path"
import type { ToolContext } from "../../src/tools/types"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

function startServer() {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/search") {
        return Response.json({
          results: [
            { title: "Agent Sandbox Paper", url: `${url.origin}/paper`, snippet: "A paper about agent sandboxing." },
          ],
        })
      }
      if (url.pathname === "/paper") {
        return new Response("<html><head><title>Agent Sandbox Paper</title></head><body><h1>Paper</h1><p>Sandbox content.</p></body></html>", {
          headers: { "content-type": "text/html" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return `http://127.0.0.1:${server.port}`
}

function context(): ToolContext {
  const cwd = process.cwd()
  return {
    cwd,
    workspaceRoot: cwd,
    permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
    pathGuard: new PathGuard({ workspaceRoot: cwd, workspaceOnly: true }),
    config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
  }
}

describe("web tools", () => {
  test("web_search returns source URLs with metadata", async () => {
    const base = startServer()
    const search = createWebTools({ searchBaseURL: `${base}/search` }).find((tool) => tool.name === "web_search")!

    const result = await search.execute({ query: "agent sandbox" }, context())

    expect(result.ok).toBe(true)
    expect(result.content).toContain("Agent Sandbox Paper")
    expect(result.content).toContain(`${base}/paper`)
    expect(result.metadata).toMatchObject({ kind: "web_search", query: "agent sandbox", resultCount: 1 })
    expect(result.metadata?.activity).toMatchObject({ kind: "search", title: "Searched web", target: "agent sandbox" })
  })

  test("web_fetch extracts readable page text with provenance", async () => {
    const base = startServer()
    const fetchTool = createWebTools({ searchBaseURL: `${base}/search` }).find((tool) => tool.name === "web_fetch")!

    const result = await fetchTool.execute({ url: `${base}/paper` }, context())

    expect(result.ok).toBe(true)
    expect(result.content).toContain("title: Agent Sandbox Paper")
    expect(result.content).toContain("Sandbox content.")
    expect(result.metadata).toMatchObject({ kind: "web_fetch", url: `${base}/paper`, status: 200 })
    expect(result.metadata?.activity).toMatchObject({ kind: "search", title: "Fetched page", target: `${base}/paper` })
  })
})

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startUiServer } from "../../src/ui/server/server"
import { E2E_HOST, E2E_LLM_PORT, E2E_PORT, E2E_TOKEN } from "../../playwright.config"

const rootDir = await mkdtemp(join(tmpdir(), "pixiu-e2e-"))
const homeDir = join(rootDir, "home")
const projectDir = join(rootDir, "project")
const fakeLlm = Bun.serve({
  hostname: E2E_HOST,
  port: E2E_LLM_PORT,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return Response.json({ error: "not found" }, { status: 404 })
    }

    const body = await request.json() as { messages?: Array<{ role?: string; content?: unknown; tool_calls?: unknown }> }
    const messages = body.messages ?? []
    const userPrompts = messages
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => message.content as string)
    const prompt = userPrompts.find((value) => /(?:permission|slow session) fixture/i.test(value)) ?? userPrompts.at(-1) ?? ""
    const requestedPermission = userPrompts.some((value) => value.toLowerCase().includes("permission fixture"))
    const requestedDoublePermission = userPrompts.some((value) => value.toLowerCase().includes("double permission fixture"))
    const requestedRichVisual = userPrompts.some((value) => value.toLowerCase().includes("rich visual fixture"))
    const toolResultCount = messages.filter((message) => message.role === "tool").length
    const needsToolCall = toolResultCount === 0 || (requestedDoublePermission && toolResultCount < 2)

    if ((requestedPermission || requestedRichVisual) && needsToolCall) {
      const path = requestedRichVisual
        ? "reports/ui-check.md"
        : requestedDoublePermission
          ? `permission-fixture-${toolResultCount + 1}.txt`
          : "permission-fixture.txt"
      const content = requestedRichVisual ? "# UI check\n\nStatus: ready\n" : "approved by e2e"
      return sseResponse([
        { choices: [{ delta: { role: "assistant" } }] },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `call_e2e_permission_${toolResultCount + 1}`,
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path, content }),
                },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ])
    }

    const answer = requestedRichVisual
      ? [
          "FINAL: ## UI review complete",
          "",
          "The workbench now keeps the important states easy to scan:",
          "",
          "- **Navigation** stays keyboard reachable.",
          "- Tool results remain attached to the assistant turn.",
          "",
          "```ts",
          "const status: \"ready\" = \"ready\"",
          "console.log(status)",
          "```",
          "",
          "> The generated report is ready for review.",
        ].join("\n")
      : `FINAL: ${requestedPermission
          ? "Permission fixture completed."
          : `E2E response: ${prompt || "ready"}`}`
    return sseResponse([
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { content: answer } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], userPrompts.some((value) => value.toLowerCase().includes("slow round trip fixture"))
      ? 3_000
      : userPrompts.some((value) => value.toLowerCase().includes("slow session fixture")) ? 750 : 0)
  },
})

await Promise.all([
  mkdir(homeDir, { recursive: true }),
  mkdir(projectDir, { recursive: true }),
  mkdir(join(projectDir, ".pixiu/skills"), { recursive: true }),
])

process.env.HOME = homeDir
process.env.XDG_CONFIG_HOME = join(homeDir, ".config")
process.env.XDG_DATA_HOME = join(homeDir, ".local/share")
process.env.XDG_STATE_HOME = join(homeDir, ".local/state")
process.env.XDG_CACHE_HOME = join(homeDir, ".cache")
process.env.PIXIU_E2E_API_KEY = "local-test-key"

await writeFile(
  join(projectDir, "pixiu.jsonc"),
  `${JSON.stringify({
    model: "openai-compatible/e2e-model",
    providers: {
      "openai-compatible": {
        type: "openai-compatible",
        baseURL: `http://${E2E_HOST}:${fakeLlm.port}/v1`,
        apiKeyEnv: "PIXIU_E2E_API_KEY",
      },
    },
    agents: {
      default: {
        description: "Deterministic Playwright agent.",
        systemPrompt: "You are running in a deterministic local UI test.",
        tools: ["read", "write", "todo"],
        maxSteps: 4,
      },
    },
    permissions: { read: "allow", write: "ask", todo: "allow" },
    skills: { paths: [".pixiu/skills"] },
    mcp: {},
    sandbox: {
      mode: "workspace",
      workspaceDir: "workspace",
      workspaceOnly: true,
      shellTimeoutMs: 5_000,
      outputMaxBytes: 8_000,
      envAllowlist: ["PATH", "HOME", "USER", "LANG", "LC_ALL", "SHELL", "TMPDIR"],
    },
  }, null, 2)}\n`,
  "utf8",
)
await writeFile(
  join(projectDir, "reference-fixture.ts"),
  "export const alpha = 1\nexport const beta = 2\nexport const gamma = 3\n",
  "utf8",
)

const ui = await startUiServer({
  cwd: projectDir,
  host: E2E_HOST,
  port: E2E_PORT,
  token: E2E_TOKEN,
  open: false,
})

console.log(`Pixiu E2E server ready at ${ui.url}`)

let closing = false
async function close() {
  if (closing) return
  closing = true
  await ui.stop().catch(() => undefined)
  fakeLlm.stop(true)
  await rm(rootDir, { recursive: true, force: true }).catch(() => undefined)
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)))
process.once("SIGTERM", () => void close().finally(() => process.exit(0)))

await new Promise(() => undefined)

function sseResponse(chunks: unknown[], delayMs = 0) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
  let timer: ReturnType<typeof setTimeout> | undefined
  const stream = delayMs > 0
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(body))
            controller.close()
          }, delayMs)
        },
        cancel() {
          if (timer) clearTimeout(timer)
        },
      })
    : body
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  })
}

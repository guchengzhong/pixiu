import { describe, expect, test } from "bun:test"
import { readFile, mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { buildRuntime } from "../../src/runtime/build"
import { defaultConfig } from "../../src/config/defaults"
import { ScriptedLLMClient } from "../fixtures/scripted-llm"

function configWithMissingKey() {
  return {
    ...defaultConfig,
    providers: {
      "openai-compatible": {
        type: "openai-compatible" as const,
        baseURL: "https://example.com/v1",
        apiKeyEnv: "MINICODE_TEST_MISSING_KEY",
      },
    },
  }
}

describe("runtime build", () => {
  test("does not run an agent without a provider API key", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-no-key-"))

    await expect(
      buildRuntime({
        cwd: root,
        config: configWithMissingKey(),
      }),
    ).rejects.toThrow("No provider API key configured")
  })

  test("can build metadata runtime without a provider API key", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-no-key-metadata-"))

    const runtime = await buildRuntime({
      cwd: root,
      config: configWithMissingKey(),
      loadLLM: false,
    })

    expect(runtime.runner).toBeUndefined()
    expect(runtime.tools.get("shell")).toBeTruthy()
  })

  test("broken MCP servers do not hide built-in tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-bad-mcp-runtime-"))
    const runtime = await buildRuntime({
      cwd: root,
      config: {
        ...configWithMissingKey(),
        mcp: {
          broken: {
            transport: "stdio",
            command: process.execPath,
            args: [join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")],
            env: { MINICODE_FAKE_MCP_MODE: "stderr-exit" },
            timeoutMs: 500,
          },
        },
      },
      loadLLM: false,
    })

    expect(runtime.tools.get("read")).toBeTruthy()
    expect(runtime.tools.get("broken.echo")).toBeUndefined()
  })

  test("runs new sessions inside workspace session directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-workspace-runtime-"))
    const runtime = await buildRuntime({
      cwd: root,
      config: {
        ...defaultConfig,
        sandbox: { ...defaultConfig.sandbox, mode: "workspace", workspaceDir: "workspace" },
      },
      yes: true,
      llm: new ScriptedLLMClient([
        [
          {
            type: "tool_call",
            call: { id: "call_1", name: "write", input: { path: "result.md", content: "# Result\n\nok" } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text_delta", text: "FINAL: done" }, { type: "finish", reason: "stop" }],
      ]),
    })

    const events = []
    for await (const event of runtime.runner.run({ message: "write result" })) events.push(event)
    const created = events.find((event) => event.type === "session_created")
    expect(created?.type).toBe("session_created")
    const sessionId = created!.sessionId
    const session = await runtime.sessions.getSession(sessionId)

    expect(session?.cwd).toBe(join(root, "workspace", sessionId))
    expect(await readFile(join(root, "workspace", sessionId, "result.md"), "utf8")).toBe("# Result\n\nok")
  })
})

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expectExit, withPixiuFixture } from "../harness/pixiu-process"

describe("pixiu chat subprocess", () => {
  test("prints startup context and shortcut hint", async () => {
    await withPixiuFixture(async ({ exec }) => {
      const result = await exec(["chat", "--no-color"], { input: "", timeoutMs: 2_000 })

      expectExit(result, 0, "chat EOF")
      expect(result.stdout).toContain("pixiu v0.0.0")
      expect(result.stdout).toContain("Tips for getting started")
      expect(result.stdout).toContain("? or /help")
      expect(result.stdout).toContain("permission default")
    })
  })

  test("starts chat when no command is provided", async () => {
    await withPixiuFixture(async ({ exec }) => {
      const result = await exec([], { input: "", timeoutMs: 2_000 })

      expectExit(result, 0, "pixiu EOF")
      expect(result.stdout).toContain("pixiu v0.0.0")
      expect(result.stdout).toContain("Recent activity")
    })
  })

  test("starts chat when only chat options are provided", async () => {
    await withPixiuFixture(async ({ exec }) => {
      const result = await exec(["--no-color"], { input: "", timeoutMs: 2_000 })

      expectExit(result, 0, "pixiu --no-color EOF")
      expect(result.stdout).toContain("pixiu v0.0.0")
      expect(result.stdout).toContain("Tips for getting started")
    })
  })

  test("supports clear and exits on Ctrl-D style EOF", async () => {
    await withPixiuFixture(async ({ exec }) => {
      const result = await exec(["chat", "--no-color"], { input: "/clear\n", timeoutMs: 2_000 })

      expectExit(result, 0, "chat /clear EOF")
      expect(result.stdout).toContain("pixiu v0.0.0")
    })
  })

  test("shows expanded help", async () => {
    await withPixiuFixture(async ({ exec }) => {
      const result = await exec(["chat", "--no-color"], { input: "/help\n/exit\n", timeoutMs: 2_000 })

      expectExit(result, 0, "chat /help")
      expect(result.stdout).toContain("/paste")
      expect(result.stdout).toContain("/compact")
      expect(result.stdout).toContain("/config")
      expect(result.stdout).toContain("/doctor")
    })
  })

  test("compacts the active session without deleting messages", async () => {
    await withPixiuFixture(async ({ llm, exec, projectDir }) => {
      for (let index = 0; index < 7; index += 1) llm.text(`FINAL: turn ${index} ok`)
      const input = [...Array.from({ length: 7 }, (_, index) => `turn ${index}`), "/compact", "/exit"].join("\n") + "\n"

      const result = await exec(["chat", "--no-color"], {
        input,
        timeoutMs: 4_000,
      })

      expectExit(result, 0, "chat /compact")
      expect(result.stdout).toContain("Compacted session")

      const sessionDir = join(projectDir, ".pixiu/state/sessions")
      const files = await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: sessionDir, onlyFiles: true }))
      expect(files.length).toBe(1)
      const content = await readFile(join(sessionDir, files[0]!), "utf8")
      expect(content).toContain("\"summary\"")
      expect(content).toContain("Compacted")
      expect(content.match(/\"type\":\"message\"/g)?.length).toBeGreaterThanOrEqual(4)
    })
  })

  test("shows session workspace, artifacts, sources, and recent shell activity", async () => {
    await withPixiuFixture(async ({ llm, exec }) => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response("<html><head><title>Agent Sandbox Paper</title></head><body><p>Sandbox content.</p></body></html>", {
            headers: { "content-type": "text/html" },
          })
        },
      })
      try {
        const url = `http://127.0.0.1:${server.port}/paper`
        llm.tool("web_fetch", { url })
        llm.tool("shell", { command: "printf session-evidence" })
        llm.tool("write", { path: "report.md", content: "# Report\n\nok" })
        llm.text("FINAL: wrote report.md")

        const result = await exec(["chat", "--no-color", "--permission-mode", "bypassPermissions"], {
          input: "collect evidence\n/session\n/exit\n",
          timeoutMs: 5_000,
        })

        expectExit(result, 0, "chat /session evidence")
        expect(result.stdout).toContain("session:")
        expect(result.stdout).toContain("workspace:")
        expect(result.stdout).toContain("artifacts:")
        expect(result.stdout).toContain("- report.md (write)")
        expect(result.stdout).toContain("sources:")
        expect(result.stdout).toContain("Agent Sandbox Paper")
        expect(result.stdout).toContain(url)
        expect(result.stdout).toContain("recent shell:")
        expect(result.stdout).toContain("[0] printf session-evidence")
      } finally {
        server.stop(true)
      }
    })
  })

  test("opens chat without an API key so config can be fixed inside the UI", async () => {
    await withPixiuFixture(async ({ exec }) => {
      const result = await exec(["chat", "--no-color"], {
        input: "/config\nhello\n/exit\n",
        env: { PIXIU_TEST_API_KEY: undefined },
        timeoutMs: 3_000,
      })

      expectExit(result, 0, "chat missing key")
      expect(result.stdout).toContain("Provider config")
      expect(result.stdout).toContain("No provider API key configured")
      expect(result.stdout).toContain("/config setup")
    })
  })

  test("sets provider config from inside chat", async () => {
    await withPixiuFixture(async ({ exec, projectDir }) => {
      const result = await exec(["chat", "--no-color"], {
        input: "/config use siliconflow sk-chat-secret deepseek-ai/DeepSeek-V3.2\n/exit\n",
        env: { PIXIU_TEST_API_KEY: undefined },
        timeoutMs: 3_000,
      })

      expectExit(result, 0, "chat config use")
      expect(result.stdout).toContain("Provider config saved")
      expect(result.stdout.split("Provider config saved.")[1] ?? "").not.toContain("sk-chat-secret")
      const raw = JSON.parse(await readFile(join(projectDir, "pixiu.jsonc"), "utf8"))
      expect(raw.model).toBe("deepseek-ai/DeepSeek-V3.2")
      expect(raw.providers["openai-compatible"].apiKey).toBe("sk-chat-secret")
    })
  })

  test("skips blank input instead of exiting", async () => {
    await withPixiuFixture(async ({ llm, exec }) => {
      llm.text("FINAL: blank skipped")

      const result = await exec(["chat", "--no-color"], { input: "\nhello after blank\n/exit\n", timeoutMs: 3_000 })

      expectExit(result, 0, "chat blank input")
      expect(result.stdout).toContain("> hello after blank")
      expect(result.stdout).toContain("blank skipped")
    })
  })

  test("supports multiline paste input", async () => {
    await withPixiuFixture(async ({ llm, exec }) => {
      llm.text("FINAL: multiline ok")

      const result = await exec(["chat", "--no-color"], { input: "/paste\nfirst line\nsecond line\n.\n/exit\n", timeoutMs: 3_000 })

      expectExit(result, 0, "chat /paste")
      expect(result.stdout).toContain("Multiline input")
      expect(result.stdout).toContain("... first line")
      expect(result.stdout).toContain("... second line")
      expect(result.stdout).toContain("multiline ok")
    })
  })

  test("renders interactive permission choices", async () => {
    await withPixiuFixture(async ({ llm, exec }) => {
      llm.tool("shell", { command: "printf permission-ok" })
      llm.text("FINAL: permission ok")

      const result = await exec(["chat", "--no-color"], { input: "run shell\n1\n/exit\n", timeoutMs: 4_000 })

      expectExit(result, 0, "chat permission prompt")
      expect(result.stdout).toContain("Permission required")
      expect(result.stdout).toContain("> 1. Yes")
      expect(result.stdout).toContain("2. Yes, and don't ask again")
      expect(result.stdout).toContain("Use")
      expect(result.stdout).toContain("Enter")
      expect(result.stdout).toContain("permission ok")
    })
  })

  test("remembers permission approval for the chat session", async () => {
    await withPixiuFixture(async ({ llm, exec }) => {
      llm.tool("shell", { command: "printf first-ok" })
      llm.text("FINAL: first ok")
      llm.tool("shell", { command: "printf second-ok" })
      llm.text("FINAL: second ok")

      const result = await exec(["chat", "--no-color"], { input: "first shell\n2\nsecond shell\n/exit\n", timeoutMs: 5_000 })

      expectExit(result, 0, "chat permission session approval")
      expect((result.stdout.match(/Permission required/g) ?? []).length).toBe(1)
      expect(result.stdout).toContain("first ok")
      expect(result.stdout).toContain("second ok")
    })
  })

  test("Ctrl-C cancels an active chat run without printing AbortError", async () => {
    await withPixiuFixture(async ({ llm, spawn }) => {
      llm.hang()
      const handle = spawn(["chat", "--no-color"], {
        input: "hang please\n/exit\n",
        timeoutMs: 5_000,
      })

      await llm.wait(1, { timeoutMs: 1_000 })
      handle.kill("SIGINT")
      const result = await handle.result()

      expectExit(result, 0, "chat SIGINT cancel")
      expect(result.stdout).toContain("Cancelled current run.")
      expect(result.stdout).toContain("Press Ctrl-C again to exit.")
      expect(result.stdout).not.toContain("AbortError")
      expect(result.stdout).not.toContain("error AbortError")
    })
  })
})

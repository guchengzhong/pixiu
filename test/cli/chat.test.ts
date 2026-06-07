import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expectExit, withMinicodeFixture } from "../harness/minicode-process"

describe("minicode chat subprocess", () => {
  test("prints startup context and shortcut hint", async () => {
    await withMinicodeFixture(async ({ exec }) => {
      const result = await exec(["chat", "--no-color"], { input: "", timeoutMs: 2_000 })

      expectExit(result, 0, "chat EOF")
      expect(result.stdout).toContain("minicode v0.0.0")
      expect(result.stdout).toContain("Tips for getting started")
      expect(result.stdout).toContain("? or /help")
      expect(result.stdout).toContain("permission default")
    })
  })

  test("starts chat when no command is provided", async () => {
    await withMinicodeFixture(async ({ exec }) => {
      const result = await exec([], { input: "", timeoutMs: 2_000 })

      expectExit(result, 0, "minicode EOF")
      expect(result.stdout).toContain("minicode v0.0.0")
      expect(result.stdout).toContain("Recent activity")
    })
  })

  test("starts chat when only chat options are provided", async () => {
    await withMinicodeFixture(async ({ exec }) => {
      const result = await exec(["--no-color"], { input: "", timeoutMs: 2_000 })

      expectExit(result, 0, "minicode --no-color EOF")
      expect(result.stdout).toContain("minicode v0.0.0")
      expect(result.stdout).toContain("Tips for getting started")
    })
  })

  test("supports clear and exits on Ctrl-D style EOF", async () => {
    await withMinicodeFixture(async ({ exec }) => {
      const result = await exec(["chat", "--no-color"], { input: "/clear\n", timeoutMs: 2_000 })

      expectExit(result, 0, "chat /clear EOF")
      expect(result.stdout).toContain("minicode v0.0.0")
    })
  })

  test("shows expanded help", async () => {
    await withMinicodeFixture(async ({ exec }) => {
      const result = await exec(["chat", "--no-color"], { input: "/help\n/exit\n", timeoutMs: 2_000 })

      expectExit(result, 0, "chat /help")
      expect(result.stdout).toContain("/paste")
      expect(result.stdout).toContain("/config")
      expect(result.stdout).toContain("/doctor")
    })
  })

  test("opens chat without an API key so config can be fixed inside the UI", async () => {
    await withMinicodeFixture(async ({ exec }) => {
      const result = await exec(["chat", "--no-color"], {
        input: "/config\nhello\n/exit\n",
        env: { MINICODE_TEST_API_KEY: undefined },
        timeoutMs: 3_000,
      })

      expectExit(result, 0, "chat missing key")
      expect(result.stdout).toContain("Provider config")
      expect(result.stdout).toContain("No provider API key configured")
      expect(result.stdout).toContain("/config setup")
    })
  })

  test("sets provider config from inside chat", async () => {
    await withMinicodeFixture(async ({ exec, projectDir }) => {
      const result = await exec(["chat", "--no-color"], {
        input: "/config use siliconflow sk-chat-secret deepseek-ai/DeepSeek-V3.2\n/exit\n",
        env: { MINICODE_TEST_API_KEY: undefined },
        timeoutMs: 3_000,
      })

      expectExit(result, 0, "chat config use")
      expect(result.stdout).toContain("Provider config saved")
      expect(result.stdout.split("Provider config saved.")[1] ?? "").not.toContain("sk-chat-secret")
      const raw = JSON.parse(await readFile(join(projectDir, "minicode.jsonc"), "utf8"))
      expect(raw.model).toBe("deepseek-ai/DeepSeek-V3.2")
      expect(raw.providers["openai-compatible"].apiKey).toBe("sk-chat-secret")
    })
  })

  test("skips blank input instead of exiting", async () => {
    await withMinicodeFixture(async ({ llm, exec }) => {
      llm.text("FINAL: blank skipped")

      const result = await exec(["chat", "--no-color"], { input: "\nhello after blank\n/exit\n", timeoutMs: 3_000 })

      expectExit(result, 0, "chat blank input")
      expect(result.stdout).toContain("> hello after blank")
      expect(result.stdout).toContain("blank skipped")
    })
  })

  test("supports multiline paste input", async () => {
    await withMinicodeFixture(async ({ llm, exec }) => {
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
    await withMinicodeFixture(async ({ llm, exec }) => {
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
    await withMinicodeFixture(async ({ llm, exec }) => {
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
})

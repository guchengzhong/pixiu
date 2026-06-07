import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expectExit, withMinicodeFixture } from "../harness/minicode-process"

describe("minicode CLI smoke subprocesses", () => {
  test("read-only commands run in an isolated project", async () => {
    await withMinicodeFixture(async ({ exec }) => {
      const doctor = await exec(["doctor"])
      expectExit(doctor, 0, "doctor")
      expect(doctor.stdout).toContain("minicode doctor")
      expect(doctor.stdout).toContain("openai-compatible/test-model")
      expect(doctor.stdout).toContain("MINICODE_TEST_API_KEY is set")

      const tools = await exec(["tool", "list"])
      expectExit(tools, 0, "tool list")
      expect(tools.stdout).toContain("shell")
      expect(tools.stdout).toContain("write")

      const sessions = await exec(["session", "list"])
      expectExit(sessions, 0, "session list")
      expect(sessions.stdout).toBe("")

      const config = await exec(["config", "validate"])
      expectExit(config, 0, "config validate")
      expect(config.stdout).toContain("config ok")

      const doctorJson = await exec(["doctor", "--json"])
      expectExit(doctorJson, 0, "doctor --json")
      expect(JSON.parse(doctorJson.stdout).checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ check: "provider", status: "ok" })]),
      )

      const setConfig = await exec(["config", "set", "sandbox.shellTimeoutMs", "7000"])
      expectExit(setConfig, 0, "config set")
      expect(setConfig.stdout).toContain("set sandbox.shellTimeoutMs")

      const getConfig = await exec(["config", "get", "sandbox.shellTimeoutMs"])
      expectExit(getConfig, 0, "config get")
      expect(JSON.parse(getConfig.stdout)).toBe(7000)
    })
  })

  test("quick provider setup writes redacted plug-and-play config", async () => {
    await withMinicodeFixture(async ({ exec, projectDir }) => {
      const result = await exec(["config", "use", "siliconflow", "sk-test-secret", "deepseek-ai/DeepSeek-V3.2"])
      expectExit(result, 0, "config use")
      expect(result.stdout).toContain("Provider config saved")
      expect(result.stdout).toContain("https://api.siliconflow.cn/v1")
      expect(result.stdout).not.toContain("sk-test-secret")

      const getKey = await exec(["config", "get", "providers.openai-compatible.apiKey"])
      expectExit(getKey, 0, "config get apiKey")
      expect(getKey.stdout).toContain("[redacted]")
      expect(getKey.stdout).not.toContain("sk-test-secret")

      const raw = JSON.parse(await readFile(join(projectDir, "minicode.jsonc"), "utf8"))
      expect(raw.model).toBe("deepseek-ai/DeepSeek-V3.2")
      expect(raw.providers["openai-compatible"].baseURL).toBe("https://api.siliconflow.cn/v1")
      expect(raw.providers["openai-compatible"].apiKey).toBe("sk-test-secret")
      expect(raw.providers["openai-compatible"].apiKeyEnv).toBeUndefined()
    })
  })

  test("quick provider setup can reference an environment variable", async () => {
    await withMinicodeFixture(async ({ exec, projectDir }) => {
      const result = await exec(["config", "use-env", "https://api.example.test/v1/", "MINICODE_API_KEY", "provider/model"])
      expectExit(result, 0, "config use-env")
      expect(result.stdout).toContain("env MINICODE_API_KEY")

      const raw = JSON.parse(await readFile(join(projectDir, "minicode.jsonc"), "utf8"))
      expect(raw.model).toBe("provider/model")
      expect(raw.providers["openai-compatible"].baseURL).toBe("https://api.example.test/v1")
      expect(raw.providers["openai-compatible"].apiKeyEnv).toBe("MINICODE_API_KEY")
      expect(raw.providers["openai-compatible"].apiKey).toBeUndefined()
    })
  })
})

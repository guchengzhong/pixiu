import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expectExit, withPixiuFixture } from "../harness/pixiu-process"

describe("pixiu CLI smoke subprocesses", () => {
  test("read-only commands run in an isolated project", async () => {
    await withPixiuFixture(async ({ exec }) => {
      const doctor = await exec(["doctor"])
      expectExit(doctor, 0, "doctor")
      expect(doctor.stdout).toContain("pixiu doctor")
      expect(doctor.stdout).toContain("openai-compatible/test-model")
      expect(doctor.stdout).toContain("PIXIU_TEST_API_KEY is set")

      const tools = await exec(["tool", "list"])
      expectExit(tools, 0, "tool list")
      expect(tools.stdout).toContain("shell")
      expect(tools.stdout).toContain("write")

      const managedTools = await exec(["tools", "env", "status"])
      expectExit(managedTools, 0, "tools env status")
      expect(managedTools.stdout).toContain("Managed tool environment")
      expect(managedTools.stdout).toContain("agent-reach")
      expect(managedTools.stdout).toContain("browser-use")

      const managedPath = await exec(["tools", "env", "path"])
      expectExit(managedPath, 0, "tools env path")
      expect(managedPath.stdout).toContain("pixiu-tools")

      const agentReachPreview = await exec(["tools", "install", "agent-reach"])
      expectExit(agentReachPreview, 0, "tools install agent-reach preview")
      expect(agentReachPreview.stdout).toContain("Managed tool install preview")
      expect(agentReachPreview.stdout).toContain("agent-reach")

      const browserUsePreview = await exec(["tools", "install", "browser-use"])
      expectExit(browserUsePreview, 0, "tools install browser-use preview")
      expect(browserUsePreview.stdout).toContain("Managed tool install preview")
      expect(browserUsePreview.stdout).toContain("browser-use")
      expect(browserUsePreview.stdout).toContain("browser-use[core]")
      expect(browserUsePreview.stdout).toContain("httpx[socks]")
      expect(browserUsePreview.stdout).toContain("SOCKS proxy")
      expect(browserUsePreview.stdout).toContain("does not enable browser-use cloud mode")

      const sessions = await exec(["session", "list"])
      expectExit(sessions, 0, "session list")
      expect(sessions.stdout).toBe("")

      const config = await exec(["config", "validate"])
      expectExit(config, 0, "config validate")
      expect(config.stdout).toContain("config ok")

      const doctorJson = await exec(["doctor", "--json"])
      expectExit(doctorJson, 0, "doctor --json")
      const parsedDoctor = JSON.parse(doctorJson.stdout)
      expect(parsedDoctor.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ check: "provider", status: "ok" })]),
      )
      expect(parsedDoctor.skillDiagnostics).toEqual([])

      const setConfig = await exec(["config", "set", "sandbox.shellTimeoutMs", "7000"])
      expectExit(setConfig, 0, "config set")
      expect(setConfig.stdout).toContain("set sandbox.shellTimeoutMs")

      const getConfig = await exec(["config", "get", "sandbox.shellTimeoutMs"])
      expectExit(getConfig, 0, "config get")
      expect(JSON.parse(getConfig.stdout)).toBe(7000)

      const setMaxSteps = await exec(["config", "max-steps", "100"])
      expectExit(setMaxSteps, 0, "config max-steps")
      expect(setMaxSteps.stdout).toContain("set agents.default.maxSteps 100")

      const showMaxSteps = await exec(["config", "max-steps"])
      expectExit(showMaxSteps, 0, "config max-steps show")
      expect(showMaxSteps.stdout).toContain("maxSteps: 100")

      const getMaxSteps = await exec(["config", "get", "agents.default.maxSteps"])
      expectExit(getMaxSteps, 0, "config get maxSteps")
      expect(JSON.parse(getMaxSteps.stdout)).toBe(100)

      const invalidMaxSteps = await exec(["config", "max-steps", "0"])
      expect(invalidMaxSteps.exitCode).toBe(1)
      expect(invalidMaxSteps.stderr).toContain("config max-steps requires an integer from 1 to 200")
    })
  })

  test("quick provider setup writes redacted plug-and-play config", async () => {
    await withPixiuFixture(async ({ exec, projectDir }) => {
      const result = await exec(["config", "use", "siliconflow", "sk-test-secret", "deepseek-ai/DeepSeek-V3.2"])
      expectExit(result, 0, "config use")
      expect(result.stdout).toContain("Provider config saved")
      expect(result.stdout).toContain("https://api.siliconflow.cn/v1")
      expect(result.stdout).not.toContain("sk-test-secret")

      const getKey = await exec(["config", "get", "providers.openai-compatible.apiKey"])
      expectExit(getKey, 0, "config get apiKey")
      expect(getKey.stdout).toContain("[redacted]")
      expect(getKey.stdout).not.toContain("sk-test-secret")

      const raw = JSON.parse(await readFile(join(projectDir, "pixiu.jsonc"), "utf8"))
      expect(raw.model).toBe("deepseek-ai/DeepSeek-V3.2")
      expect(raw.providers["openai-compatible"].baseURL).toBe("https://api.siliconflow.cn/v1")
      expect(raw.providers["openai-compatible"].apiKey).toBe("sk-test-secret")
      expect(raw.providers["openai-compatible"].apiKeyEnv).toBeUndefined()
    })
  })

  test("quick provider setup can reference an environment variable", async () => {
    await withPixiuFixture(async ({ exec, projectDir }) => {
      const result = await exec(["config", "use-env", "https://api.example.test/v1/", "PIXIU_API_KEY", "provider/model"])
      expectExit(result, 0, "config use-env")
      expect(result.stdout).toContain("env PIXIU_API_KEY")

      const raw = JSON.parse(await readFile(join(projectDir, "pixiu.jsonc"), "utf8"))
      expect(raw.model).toBe("provider/model")
      expect(raw.providers["openai-compatible"].baseURL).toBe("https://api.example.test/v1")
      expect(raw.providers["openai-compatible"].apiKeyEnv).toBe("PIXIU_API_KEY")
      expect(raw.providers["openai-compatible"].apiKey).toBeUndefined()
    })
  })
})

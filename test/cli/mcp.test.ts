import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { expectExit, withMinicodeFixture } from "../harness/minicode-process"

describe("mcp CLI", () => {
  test("add writes stdio and http MCP server config", async () => {
    await withMinicodeFixture(async ({ projectDir, exec }) => {
      const configPath = join(projectDir, "minicode.jsonc")
      const fakeMcp = join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")

      const stdio = await exec([
        "mcp",
        "add",
        "stdio",
        "local",
        "--timeout-ms",
        "1000",
        "--env",
        "MINICODE_FAKE_MCP_MODE=echo",
        "--json",
        "--",
        process.execPath,
        fakeMcp,
      ])
      expectExit(stdio, 0, "mcp add stdio")
      expect(JSON.parse(stdio.stdout)).toMatchObject({
        name: "local",
        server: {
          transport: "stdio",
          command: process.execPath,
          args: [fakeMcp],
          env: { MINICODE_FAKE_MCP_MODE: "echo" },
          timeoutMs: 1000,
        },
        overwritten: false,
      })

      const duplicate = await exec(["mcp", "add", "stdio", "local", "--", process.execPath, fakeMcp])
      expectExit(duplicate, 1, "duplicate mcp add stdio")
      expect(duplicate.stderr).toContain("MCP server already exists")

      const http = await exec([
        "mcp",
        "add",
        "http",
        "remote",
        "http://127.0.0.1:9876/mcp",
        "--timeout-ms",
        "250",
        "--header",
        "Authorization=Bearer test",
        "--json",
      ])
      expectExit(http, 0, "mcp add http")

      const config = JSON.parse(await readFile(configPath, "utf8"))
      expect(config.mcp.local).toMatchObject({
        transport: "stdio",
        command: process.execPath,
        args: [fakeMcp],
        env: { MINICODE_FAKE_MCP_MODE: "echo" },
        timeoutMs: 1000,
      })
      expect(config.mcp.remote).toMatchObject({
        transport: "http",
        url: "http://127.0.0.1:9876/mcp",
        headers: { Authorization: "Bearer test" },
        timeoutMs: 250,
      })
    })
  })

  test("enable disable and remove update MCP server config", async () => {
    await withMinicodeFixture(async ({ projectDir, exec }) => {
      const configPath = join(projectDir, "minicode.jsonc")
      const fakeMcp = join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")
      expectExit(await exec(["mcp", "add", "stdio", "local", "--", process.execPath, fakeMcp]), 0, "mcp add stdio")

      const disabled = await exec(["mcp", "disable", "local", "--json"])
      expectExit(disabled, 0, "mcp disable")
      expect(JSON.parse(disabled.stdout)).toMatchObject({ name: "local", enabled: false, changed: true })
      let config = JSON.parse(await readFile(configPath, "utf8"))
      expect(config.mcp.local.enabled).toBe(false)

      const list = await exec(["mcp", "list"])
      expectExit(list, 0, "mcp list disabled")
      expect(list.stdout).toContain("server")
      expect(list.stdout).toContain("status")
      expect(list.stdout).toContain("transport")
      expect(list.stdout).toContain("tools")
      expect(list.stdout).toContain("local")
      expect(list.stdout).toContain("disabled")
      expect(list.stdout).toContain("stdio")

      const enabled = await exec(["mcp", "enable", "local", "--json"])
      expectExit(enabled, 0, "mcp enable")
      expect(JSON.parse(enabled.stdout)).toMatchObject({ name: "local", enabled: true, changed: true })
      config = JSON.parse(await readFile(configPath, "utf8"))
      expect(config.mcp.local.enabled).toBeUndefined()

      const removed = await exec(["mcp", "remove", "local", "--json"])
      expectExit(removed, 0, "mcp remove")
      expect(JSON.parse(removed.stdout)).toMatchObject({ name: "local", changed: true })
      config = JSON.parse(await readFile(configPath, "utf8"))
      expect(config.mcp.local).toBeUndefined()
    })
  })

  test("metadata CLI commands exit when MCP stdio servers are configured", async () => {
    await withMinicodeFixture(async ({ exec }) => {
      const fakeMcp = join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")
      expectExit(await exec(["mcp", "add", "stdio", "local", "--", process.execPath, fakeMcp]), 0, "mcp add stdio")

      const skills = await exec(["skill", "list", "--json"], { timeoutMs: 1_000 })
      expectExit(skills, 0, "skill list with mcp")
      expect(JSON.parse(skills.stdout).diagnostics).toEqual([])

      const tools = await exec(["tool", "list"], { timeoutMs: 1_000 })
      expectExit(tools, 0, "tool list with mcp")
      expect(tools.stdout).toContain("shell")
      expect(tools.stdout).toContain("Run a shell command")
    })
  })

  test("run command closes MCP stdio clients after completion", async () => {
    await withMinicodeFixture(async ({ exec, llm }) => {
      const fakeMcp = join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")
      expectExit(await exec(["mcp", "add", "stdio", "local", "--", process.execPath, fakeMcp]), 0, "mcp add stdio")
      llm.text("FINAL: run closed mcp")

      const result = await exec(["run", "--json", "hello"], { timeoutMs: 2_000 })
      expectExit(result, 0, "run with mcp")
      expect(result.stdout).toContain("run closed mcp")
    })
  })

  test("list shows connected, failed, and disabled server status", async () => {
    await withMinicodeFixture(async ({ projectDir, exec }) => {
      const configPath = join(projectDir, "minicode.jsonc")
      const config = JSON.parse(await readFile(configPath, "utf8"))
      const fakeMcp = join(import.meta.dir, "..", "fixtures", "fake-mcp.ts")
      config.mcp = {
        ok: {
          transport: "stdio",
          command: process.execPath,
          args: [fakeMcp],
          timeoutMs: 1_000,
        },
        broken: {
          transport: "stdio",
          command: process.execPath,
          args: [fakeMcp],
          env: { MINICODE_FAKE_MCP_MODE: "stderr-exit" },
          timeoutMs: 500,
        },
        off: {
          enabled: false,
          transport: "stdio",
          command: process.execPath,
          args: [fakeMcp],
        },
      }
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

      const result = await exec(["mcp", "list"])
      expectExit(result, 0, "mcp list")
      expect(result.stdout).toContain("ok")
      expect(result.stdout).toContain("connected")
      expect(result.stdout).toContain("stdio")
      expect(result.stdout).toContain("broken")
      expect(result.stdout).toContain("failed")
      expect(result.stdout).toContain("fake mcp boom stderr")
      expect(result.stdout).toContain("off")
      expect(result.stdout).toContain("disabled")
      expect(result.stdout).toContain("echo")

      const json = await exec(["mcp", "list", "--json"])
      expectExit(json, 0, "mcp list --json")
      const parsed = JSON.parse(json.stdout)
      expect(parsed.servers.map((server: { status: string }) => server.status).sort()).toEqual(["connected", "disabled", "failed"])
      expect(parsed.servers.find((server: { name: string }) => server.name === "ok")?.tools).toBe(1)
      expect(parsed.servers.find((server: { name: string }) => server.name === "ok")?.transport).toBe("stdio")

      const doctor = await exec(["mcp", "doctor", "--json"])
      expectExit(doctor, 1, "mcp doctor --json")
      const report = JSON.parse(doctor.stdout)
      expect(report.summary).toEqual({ configured: 3, connected: 1, failed: 1, disabled: 1 })
      expect(report.servers.find((server: { name: string }) => server.name === "broken")?.error).toContain("fake mcp boom stderr")
    })
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { loadConfig } from "../../src/config/loader"

describe("config loader", () => {
  test("loads defaults without config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-config-"))
    const config = await loadConfig({ cwd: root })
    expect(config.agents.default?.maxSteps).toBeGreaterThan(0)
    expect(config.ui.accentColor).toBe("#3B8EEA")
    expect(config.sandbox.envAllowlist).toEqual(
      expect.arrayContaining(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]),
    )
    expect(config.tools.managedEnv).toMatchObject({
      enabled: true,
      manager: "conda",
      name: "pixiu-tools",
      autoInstall: "ask",
    })
  })

  test("loads a custom ui accent color", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-config-ui-"))
    await writeFile(join(root, "pixiu.jsonc"), `{"ui":{"accentColor":"#065880"}}`, "utf8")
    const config = await loadConfig({ cwd: root })
    expect(config.ui.accentColor).toBe("#065880")
  })

  test("loads legacy minicode config when pixiu config is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-config-legacy-"))
    await writeFile(join(root, "minicode.jsonc"), `{"ui":{"accentColor":"#225588"}}`, "utf8")
    const config = await loadConfig({ cwd: root })
    expect(config.ui.accentColor).toBe("#225588")
  })

  test("prefers pixiu config over legacy minicode config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-config-prefer-"))
    await writeFile(join(root, "minicode.jsonc"), `{"ui":{"accentColor":"#225588"}}`, "utf8")
    await writeFile(join(root, "pixiu.jsonc"), `{"ui":{"accentColor":"#116677"}}`, "utf8")
    const config = await loadConfig({ cwd: root })
    expect(config.ui.accentColor).toBe("#116677")
  })

  test("points to invalid permission field", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-config-bad-"))
    await writeFile(join(root, "pixiu.jsonc"), `{"permissions":{"shell":"maybe"}}`, "utf8")
    await expect(loadConfig({ cwd: root })).rejects.toThrow("config.permissions.shell")
  })

  test("points to invalid ui accent color", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-config-bad-ui-"))
    await writeFile(join(root, "pixiu.jsonc"), `{"ui":{"accentColor":"blue"}}`, "utf8")
    await expect(loadConfig({ cwd: root })).rejects.toThrow("config.ui.accentColor")
  })

  test("points to invalid managed tool environment config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-config-bad-tools-"))
    await writeFile(join(root, "pixiu.jsonc"), `{"tools":{"managedEnv":{"manager":"global-pip"}}}`, "utf8")
    await expect(loadConfig({ cwd: root })).rejects.toThrow("config.tools.managedEnv.manager")
  })
})

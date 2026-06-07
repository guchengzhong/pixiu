import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { loadConfig } from "../../src/config/loader"

describe("config loader", () => {
  test("loads defaults without config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-config-"))
    const config = await loadConfig({ cwd: root })
    expect(config.agents.default?.maxSteps).toBeGreaterThan(0)
    expect(config.ui.accentColor).toBe("#3B8EEA")
  })

  test("loads a custom ui accent color", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-config-ui-"))
    await writeFile(join(root, "minicode.jsonc"), `{"ui":{"accentColor":"#065880"}}`, "utf8")
    const config = await loadConfig({ cwd: root })
    expect(config.ui.accentColor).toBe("#065880")
  })

  test("points to invalid permission field", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-config-bad-"))
    await writeFile(join(root, "minicode.jsonc"), `{"permissions":{"shell":"maybe"}}`, "utf8")
    await expect(loadConfig({ cwd: root })).rejects.toThrow("config.permissions.shell")
  })

  test("points to invalid ui accent color", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-config-bad-ui-"))
    await writeFile(join(root, "minicode.jsonc"), `{"ui":{"accentColor":"blue"}}`, "utf8")
    await expect(loadConfig({ cwd: root })).rejects.toThrow("config.ui.accentColor")
  })
})

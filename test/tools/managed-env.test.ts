import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BROWSER_USE_PACKAGE_REFS, buildManagedEnvPATH, findAgentReachSource, inspectManagedEnv } from "../../src/tools/managed-env"
import { defaultConfig, type PixiuConfig } from "../../src/config/defaults"

describe("managed tool environment", () => {
  test("inspects configured env path and installed tool binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-managed-env-"))
    const envPath = join(root, "pixiu-tools")
    const binPath = join(envPath, "bin")
    await mkdir(binPath, { recursive: true })
    await writeFile(join(binPath, "agent-reach"), "#!/bin/sh\n", "utf8")
    await writeFile(join(binPath, "browser-use"), "#!/bin/sh\n", "utf8")

    const status = await inspectManagedEnv(configWithEnvPath(envPath))

    expect(status.envPath).toBe(envPath)
    expect(status.binPath).toBe(binPath)
    expect(status.exists).toBe(true)
    expect(status.tools["agent-reach"]).toMatchObject({
      available: true,
      path: join(binPath, "agent-reach"),
    })
    expect(status.tools["browser-use"]).toMatchObject({
      available: true,
      path: join(binPath, "browser-use"),
    })
  })

  test("builds a PATH with managed env bin first without duplicating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-managed-path-"))
    const envPath = join(root, "pixiu-tools")
    const config = configWithEnvPath(envPath)
    const binPath = join(envPath, "bin")

    expect(buildManagedEnvPATH(config, "/usr/bin")).toBe(`${binPath}:/usr/bin`)
    expect(buildManagedEnvPATH(config, `${binPath}:/usr/bin`)).toBe(`${binPath}:/usr/bin`)
  })

  test("finds a local Agent Reach source checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-reach-source-"))
    const source = join(root, "Agent-Reach")
    await mkdir(join(source, "agent_reach"), { recursive: true })
    await writeFile(join(source, "pyproject.toml"), "[project]\nname = \"agent-reach\"\n", "utf8")

    await mkdir(join(root, "pixiu"))
    expect(await findAgentReachSource(join(root, "pixiu"))).toBe(source)
  })

  test("browser-use install includes socks proxy support", () => {
    expect(BROWSER_USE_PACKAGE_REFS).toEqual(["browser-use[core]", "httpx[socks]"])
  })
})

function configWithEnvPath(envPath: string): PixiuConfig {
  return {
    ...defaultConfig,
    tools: {
      managedEnv: {
        ...defaultConfig.tools.managedEnv,
        path: envPath,
      },
    },
  }
}

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { tmpdir } from "node:os"

import { BROWSER_USE_PACKAGE_REFS, buildManagedEnvPATH, findAgentReachSource, inspectManagedEnv } from "../../src/tools/managed-env"
import { defaultConfig, type PixiuConfig } from "../../src/config/defaults"

describe("managed tool environment", () => {
  test("inspects configured env path and installed tool binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-managed-env-"))
    const envPath = join(root, "pixiu-tools")
    const expectedBinPaths = expectedExecutablePaths(envPath)
    const toolDir = process.platform === "win32" ? join(envPath, "Scripts") : join(envPath, "bin")
    const agentReachPath = join(toolDir, process.platform === "win32" ? "agent-reach.exe" : "agent-reach")
    const browserUsePath = join(toolDir, process.platform === "win32" ? "browser-use.exe" : "browser-use")
    await mkdir(toolDir, { recursive: true })
    await writeFile(agentReachPath, "#!/bin/sh\n", "utf8")
    await writeFile(browserUsePath, "#!/bin/sh\n", "utf8")

    const status = await inspectManagedEnv(configWithEnvPath(envPath))

    expect(status.envPath).toBe(envPath)
    expect(status.binPath).toBe(expectedBinPaths[0]!)
    expect(status.binPaths).toEqual(expectedBinPaths)
    expect(status.exists).toBe(true)
    expect(status.tools["agent-reach"]).toMatchObject({
      available: true,
      path: agentReachPath,
    })
    expect(status.tools["browser-use"]).toMatchObject({
      available: true,
      path: browserUsePath,
    })
  })

  test("builds a PATH with managed env bin first without duplicating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-managed-path-"))
    const envPath = join(root, "pixiu-tools")
    const config = configWithEnvPath(envPath)
    const expectedBinPaths = expectedExecutablePaths(envPath)
    const expectedPath = [...expectedBinPaths, "/usr/bin"].join(delimiter)

    expect(buildManagedEnvPATH(config, "/usr/bin")).toBe(expectedPath)
    expect(buildManagedEnvPATH(config, expectedPath)).toBe(expectedPath)
  })

  test("discovers a named conda env from CONDA_ENVS_PATH when no env path is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-managed-envs-path-"))
    const envsDir = join(root, "custom-envs")
    const envPath = join(envsDir, "pixiu-tools")
    await mkdir(envPath, { recursive: true })

    await withEnv({ CONDA_PREFIX: undefined, CONDA_ENVS_PATH: envsDir }, async () => {
      const status = await inspectManagedEnv(configWithoutEnvPath())

      expect(status.envPath).toBe(envPath)
      expect(status.exists).toBe(true)
    })
  })

  test("discovers a named conda env from condarc envs_dirs when no env path is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-managed-condarc-"))
    const envsDir = join(root, "condarc-envs")
    const envPath = join(envsDir, "pixiu-tools")
    const condarc = join(root, ".condarc")
    await mkdir(envPath, { recursive: true })
    await writeFile(condarc, ["envs_dirs:", `  - ${envsDir}`, ""].join("\n"), "utf8")

    await withEnv({ CONDA_PREFIX: undefined, CONDA_ENVS_PATH: undefined, CONDARC: condarc }, async () => {
      const status = await inspectManagedEnv(configWithoutEnvPath())

      expect(status.envPath).toBe(envPath)
      expect(status.exists).toBe(true)
    })
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

function configWithoutEnvPath(): PixiuConfig {
  const managedEnv: PixiuConfig["tools"]["managedEnv"] = { ...defaultConfig.tools.managedEnv }
  delete managedEnv.path
  return {
    ...defaultConfig,
    tools: {
      managedEnv,
    },
  }
}

function expectedExecutablePaths(envPath: string) {
  if (process.platform === "win32") {
    return [envPath, join(envPath, "Scripts"), join(envPath, "Library", "bin"), join(envPath, "bin")]
  }
  return [join(envPath, "bin")]
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

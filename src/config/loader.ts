import { access } from "node:fs/promises"
import { resolve } from "node:path"

import { defaultConfig, type PixiuConfig, type PermissionAction } from "./defaults"
import { PixiuError } from "../shared/errors"
import { readJsoncFile } from "../shared/json"

const CONFIG_FILE = "pixiu.jsonc"
const LEGACY_CONFIG_FILE = "minicode.jsonc"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeDeep<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return patch === undefined ? base : (patch as T)
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key]
    merged[key] = isRecord(current) && isRecord(value) ? mergeDeep(current, value) : value
  }
  return merged as T
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function loadConfig(options: { cwd?: string; path?: string } = {}) {
  const cwd = options.cwd ?? process.cwd()
  const configPath = await resolveConfigPath(cwd, options.path)
  const fileConfig = (await exists(configPath)) ? await readJsoncFile<Partial<PixiuConfig>>(configPath) : {}
  const config = mergeDeep<PixiuConfig>(defaultConfig, fileConfig)
  validateConfig(config)
  return config
}

async function resolveConfigPath(cwd: string, path?: string) {
  if (path) return resolve(cwd, path)
  const primary = resolve(cwd, CONFIG_FILE)
  if (await exists(primary)) return primary
  const legacy = resolve(cwd, LEGACY_CONFIG_FILE)
  return (await exists(legacy)) ? legacy : primary
}

export function resolveProviderConfig(config: PixiuConfig, name = "openai-compatible") {
  const provider = config.providers[name]
  if (!provider) throw new PixiuError(`Unknown provider: ${name}`, { code: "UNKNOWN_PROVIDER" })
  const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
  return { ...provider, apiKey }
}

export function validateConfig(config: PixiuConfig) {
  const actions = new Set<PermissionAction>(["allow", "ask", "deny"])
  if (!config.model) throw new PixiuError("config.model is required", { code: "CONFIG_INVALID" })
  if (!isRecord(config.project) || !isRecord(config.project.commands)) {
    throw new PixiuError("config.project.commands must contain an object", { code: "CONFIG_INVALID" })
  }
  for (const name of ["test", "typecheck", "build"] as const) {
    const command = config.project.commands[name]
    if (command !== undefined && (typeof command !== "string" || !command.trim())) {
      throw new PixiuError(`config.project.commands.${name} must be a non-empty string`, { code: "CONFIG_INVALID" })
    }
  }
  if (!config.agents.default) throw new PixiuError("config.agents.default is required", { code: "CONFIG_INVALID" })
  if (!["local", "workspace"].includes(config.sandbox.mode)) {
    throw new PixiuError(`config.sandbox.mode has invalid value: ${String(config.sandbox.mode)}`, {
      code: "CONFIG_INVALID",
    })
  }
  if (!config.sandbox.workspaceDir) {
    throw new PixiuError("config.sandbox.workspaceDir is required", { code: "CONFIG_INVALID" })
  }
  if (!isRecord(config.ui) || typeof config.ui.accentColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(config.ui.accentColor)) {
    throw new PixiuError("config.ui.accentColor must be a hex color like #3B8EEA", { code: "CONFIG_INVALID" })
  }
  if (!isRecord(config.tools) || !isRecord(config.tools.managedEnv)) {
    throw new PixiuError("config.tools.managedEnv is required", { code: "CONFIG_INVALID" })
  }
  const managedEnv = config.tools.managedEnv
  if (!["conda", "mamba", "micromamba", "venv"].includes(managedEnv.manager)) {
    throw new PixiuError(`config.tools.managedEnv.manager has invalid value: ${String(managedEnv.manager)}`, {
      code: "CONFIG_INVALID",
    })
  }
  if (!["off", "ask", "allow"].includes(managedEnv.autoInstall)) {
    throw new PixiuError(`config.tools.managedEnv.autoInstall has invalid value: ${String(managedEnv.autoInstall)}`, {
      code: "CONFIG_INVALID",
    })
  }
  if (!managedEnv.name || typeof managedEnv.name !== "string") {
    throw new PixiuError("config.tools.managedEnv.name is required", { code: "CONFIG_INVALID" })
  }
  for (const [tool, rule] of Object.entries(config.permissions)) {
    const action = typeof rule === "string" ? rule : rule.action
    if (!actions.has(action)) {
      throw new PixiuError(`config.permissions.${tool} has invalid action: ${String(action)}`, {
        code: "CONFIG_INVALID",
      })
    }
  }
  return true
}

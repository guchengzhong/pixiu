import { access } from "node:fs/promises"
import { resolve } from "node:path"

import { defaultConfig, type MinicodeConfig, type PermissionAction } from "./defaults"
import { MinicodeError } from "../shared/errors"
import { readJsoncFile } from "../shared/json"

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
  const configPath = options.path ? resolve(cwd, options.path) : resolve(cwd, "minicode.jsonc")
  const fileConfig = (await exists(configPath)) ? await readJsoncFile<Partial<MinicodeConfig>>(configPath) : {}
  const config = mergeDeep<MinicodeConfig>(defaultConfig, fileConfig)
  validateConfig(config)
  return config
}

export function resolveProviderConfig(config: MinicodeConfig, name = "openai-compatible") {
  const provider = config.providers[name]
  if (!provider) throw new MinicodeError(`Unknown provider: ${name}`, { code: "UNKNOWN_PROVIDER" })
  const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
  return { ...provider, apiKey }
}

export function validateConfig(config: MinicodeConfig) {
  const actions = new Set<PermissionAction>(["allow", "ask", "deny"])
  if (!config.model) throw new MinicodeError("config.model is required", { code: "CONFIG_INVALID" })
  if (!config.agents.default) throw new MinicodeError("config.agents.default is required", { code: "CONFIG_INVALID" })
  if (!["local", "workspace"].includes(config.sandbox.mode)) {
    throw new MinicodeError(`config.sandbox.mode has invalid value: ${String(config.sandbox.mode)}`, {
      code: "CONFIG_INVALID",
    })
  }
  if (!config.sandbox.workspaceDir) {
    throw new MinicodeError("config.sandbox.workspaceDir is required", { code: "CONFIG_INVALID" })
  }
  if (!isRecord(config.ui) || typeof config.ui.accentColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(config.ui.accentColor)) {
    throw new MinicodeError("config.ui.accentColor must be a hex color like #3B8EEA", { code: "CONFIG_INVALID" })
  }
  for (const [tool, rule] of Object.entries(config.permissions)) {
    const action = typeof rule === "string" ? rule : rule.action
    if (!actions.has(action)) {
      throw new MinicodeError(`config.permissions.${tool} has invalid action: ${String(action)}`, {
        code: "CONFIG_INVALID",
      })
    }
  }
  return true
}

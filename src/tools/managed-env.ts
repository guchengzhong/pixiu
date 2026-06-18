import { access, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

import type { PixiuConfig } from "../config/defaults"

export type ManagedEnvConfig = PixiuConfig["tools"]["managedEnv"]

export type ManagedEnvStatus = {
  enabled: boolean
  manager: ManagedEnvConfig["manager"]
  name: string
  python: string
  autoCreate: boolean
  prependPath: boolean
  autoInstall: ManagedEnvConfig["autoInstall"]
  envPath: string
  binPath: string
  managerCommand?: string
  managerAvailable: boolean
  exists: boolean
  pathActive: boolean
  tools: Record<string, { command: string; available: boolean; path?: string }>
}

export type ManagedEnvRunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export const BROWSER_USE_PACKAGE_REFS = ["browser-use[core]", "httpx[socks]"] as const

export function resolveManagedEnv(config: PixiuConfig, options: { cwd?: string } = {}) {
  const env = config.tools.managedEnv
  const envPath = env.path ? expandHome(env.path) : defaultEnvPath(env)
  return {
    config: env,
    envPath,
    binPath: env.manager === "venv" && process.platform === "win32" ? join(envPath, "Scripts") : join(envPath, "bin"),
    managerCommand: findManagerCommand(env.manager),
    cwd: options.cwd ?? process.cwd(),
  }
}

export async function inspectManagedEnv(config: PixiuConfig, options: { cwd?: string; tools?: string[] } = {}): Promise<ManagedEnvStatus> {
  const resolved = resolveManagedEnv(config, options)
  const tools = options.tools ?? ["agent-reach", "browser-use"]
  const exists = await pathExists(resolved.envPath)
  const managerAvailable = Boolean(resolved.managerCommand)
  const binPath = resolved.binPath
  return {
    enabled: resolved.config.enabled,
    manager: resolved.config.manager,
    name: resolved.config.name,
    python: resolved.config.python,
    autoCreate: resolved.config.autoCreate,
    prependPath: resolved.config.prependPath,
    autoInstall: resolved.config.autoInstall,
    envPath: resolved.envPath,
    binPath,
    ...(resolved.managerCommand ? { managerCommand: resolved.managerCommand } : {}),
    managerAvailable,
    exists,
    pathActive: pathContains(process.env.PATH ?? "", binPath),
    tools: Object.fromEntries(
      await Promise.all(tools.map(async (tool) => [tool, await inspectManagedTool(tool, binPath)] as const)),
    ),
  }
}

export function managedEnvPathPrepend(config: PixiuConfig) {
  const resolved = resolveManagedEnv(config)
  if (!resolved.config.enabled || !resolved.config.prependPath) return undefined
  return resolved.binPath
}

export function buildManagedEnvPATH(config: PixiuConfig, currentPath = process.env.PATH ?? "") {
  const prepend = managedEnvPathPrepend(config)
  if (!prepend) return currentPath
  if (pathContains(currentPath, prepend)) return currentPath
  return [prepend, currentPath].filter(Boolean).join(delimiter)
}

export async function createManagedEnv(config: PixiuConfig, options: { cwd?: string } = {}): Promise<ManagedEnvRunResult> {
  const resolved = resolveManagedEnv(config, options)
  if (!resolved.config.enabled) return { exitCode: 1, stdout: "", stderr: "Managed tool environment is disabled." }
  if (await pathExists(resolved.envPath)) return { exitCode: 0, stdout: `Managed tool environment already exists: ${resolved.envPath}\n`, stderr: "" }
  if (resolved.config.manager === "venv") {
    await mkdir(dirname(resolved.envPath), { recursive: true })
    return runCommand("python3", ["-m", "venv", resolved.envPath], { cwd: resolved.cwd })
  }
  if (!resolved.managerCommand) {
    return { exitCode: 127, stdout: "", stderr: `${resolved.config.manager} not found in PATH.` }
  }
  await mkdir(dirname(resolved.envPath), { recursive: true })
  if (shouldUseEnvPath(resolved.config)) {
    return runCommand(resolved.managerCommand, ["create", "-y", "-p", resolved.envPath, `python=${resolved.config.python}`], { cwd: resolved.cwd })
  }
  return runCommand(resolved.managerCommand, ["create", "-y", "-n", resolved.config.name, `python=${resolved.config.python}`], { cwd: resolved.cwd })
}

export async function installAgentReach(config: PixiuConfig, options: { cwd?: string; sourcePath?: string } = {}): Promise<ManagedEnvRunResult> {
  const resolved = resolveManagedEnv(config, options)
  if (!resolved.config.enabled) return { exitCode: 1, stdout: "", stderr: "Managed tool environment is disabled." }
  if (!(await pathExists(resolved.envPath))) {
    const created = await createManagedEnv(config, options)
    if (created.exitCode !== 0) return created
  }
  const sourcePath = options.sourcePath ?? (await findAgentReachSource(options.cwd ?? process.cwd()))
  const packageRef = sourcePath ?? "agent-reach"
  if (resolved.config.manager === "venv") {
    const python = join(resolved.binPath, process.platform === "win32" ? "python.exe" : "python")
    return runCommand(python, ["-m", "pip", "install", sourcePath ? "-e" : "", packageRef].filter(Boolean), {
      cwd: options.cwd ?? process.cwd(),
      env: managedPythonEnv(config),
    })
  }
  if (!resolved.managerCommand) {
    return { exitCode: 127, stdout: "", stderr: `${resolved.config.manager} not found in PATH.` }
  }
  const targetArgs = shouldUseEnvPath(resolved.config)
    ? ["run", "-p", resolved.envPath]
    : ["run", "-n", resolved.config.name]
  return runCommand(resolved.managerCommand, [...targetArgs, "python", "-m", "pip", "install", ...(sourcePath ? ["-e"] : []), packageRef], {
    cwd: options.cwd ?? process.cwd(),
    env: managedPythonEnv(config),
  })
}

export async function installBrowserUse(config: PixiuConfig, options: { cwd?: string } = {}): Promise<ManagedEnvRunResult> {
  return installPythonPackage(config, [...BROWSER_USE_PACKAGE_REFS], options)
}

export async function findAgentReachSource(cwd: string) {
  const candidates = [...agentReachCandidates(cwd), "/home/gujing/code/Agent-Reach"]
  for (const candidate of unique(candidates)) {
    if (await isAgentReachSource(candidate)) return candidate
  }
  return undefined
}

function agentReachCandidates(cwd: string) {
  const candidates: string[] = []
  let current = resolve(cwd)
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(current, "Agent-Reach"))
    candidates.push(join(dirname(current), "Agent-Reach"))
    const next = dirname(current)
    if (next === current) break
    current = next
  }
  return candidates
}

function defaultEnvPath(config: ManagedEnvConfig) {
  if (config.manager === "venv") return join(homedir(), ".pixiu", "tools", config.name)
  const condaPrefix = process.env.CONDA_PREFIX
  if (condaPrefix && condaPrefix.endsWith(config.name)) return condaPrefix
  const condaRoot = process.env.CONDA_EXE ? dirname(dirname(process.env.CONDA_EXE)) : join(homedir(), "miniconda3")
  return join(condaRoot, "envs", config.name)
}

function shouldUseEnvPath(config: ManagedEnvConfig) {
  return config.manager === "micromamba" || Boolean(config.path)
}

function managedPythonEnv(config: PixiuConfig) {
  return {
    PATH: buildManagedEnvPATH(config),
    PYTHONNOUSERSITE: "1",
  }
}

function findManagerCommand(manager: ManagedEnvConfig["manager"]) {
  if (manager === "venv") return commandInPath("python3")
  const envName = manager === "conda" ? "CONDA_EXE" : undefined
  if (envName && process.env[envName]) return process.env[envName]
  return commandInPath(manager)
}

function commandInPath(command: string) {
  const path = process.env.PATH ?? ""
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${command}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

async function inspectManagedTool(command: string, binPath: string) {
  const path = await executablePath(command, binPath)
  return {
    command,
    available: Boolean(path),
    ...(path ? { path } : {}),
  }
}

async function executablePath(command: string, binPath: string) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const suffix of suffixes) {
    const candidate = join(binPath, `${command}${suffix}`)
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

async function isAgentReachSource(path: string) {
  if (!(await pathExists(join(path, "pyproject.toml")))) return false
  if (!(await pathExists(join(path, "agent_reach")))) return false
  return true
}

async function installPythonPackage(config: PixiuConfig, packageRef: string | string[], options: { cwd?: string } = {}): Promise<ManagedEnvRunResult> {
  const resolved = resolveManagedEnv(config, options)
  const packageRefs = Array.isArray(packageRef) ? packageRef : [packageRef]
  if (!resolved.config.enabled) return { exitCode: 1, stdout: "", stderr: "Managed tool environment is disabled." }
  if (!(await pathExists(resolved.envPath))) {
    const created = await createManagedEnv(config, options)
    if (created.exitCode !== 0) return created
  }
  if (resolved.config.manager === "venv") {
    const python = join(resolved.binPath, process.platform === "win32" ? "python.exe" : "python")
    return runCommand(python, ["-m", "pip", "install", ...packageRefs], {
      cwd: options.cwd ?? process.cwd(),
      env: managedPythonEnv(config),
    })
  }
  if (!resolved.managerCommand) {
    return { exitCode: 127, stdout: "", stderr: `${resolved.config.manager} not found in PATH.` }
  }
  const targetArgs = shouldUseEnvPath(resolved.config)
    ? ["run", "-p", resolved.envPath]
    : ["run", "-n", resolved.config.name]
  return runCommand(resolved.managerCommand, [...targetArgs, "python", "-m", "pip", "install", ...packageRefs], {
    cwd: options.cwd ?? process.cwd(),
    env: managedPythonEnv(config),
  })
}

async function pathExists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function runCommand(command: string, args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<ManagedEnvRunResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }))
    child.on("error", (error) => resolve({ exitCode: 127, stdout, stderr: error.message }))
  })
}

function pathContains(pathValue: string, target: string) {
  return pathValue.split(delimiter).some((item) => item === target)
}

function expandHome(path: string) {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
}

function unique(values: string[]) {
  return [...new Set(values)]
}

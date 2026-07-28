import { access, readFile, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import type { ProjectCommands } from "../config/defaults"
import { PixiuError } from "../shared/errors"
import { parseJsonc } from "../shared/json"

const CONFIG_FILE = "pixiu.jsonc"
const LEGACY_CONFIG_FILE = "minicode.jsonc"
const COMMAND_NAMES = ["test", "typecheck", "build"] as const

type PackageManager = "bun" | "npm" | "pnpm" | "yarn"

type PackageManifest = {
  packageManager?: unknown
  scripts?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  peerDependencies?: unknown
}

export type ProjectInitResult = {
  created: boolean
  path: string
  commands: ProjectCommands
}

export async function initializeProject(cwd = process.cwd()): Promise<ProjectInitResult> {
  const root = resolve(cwd)
  for (const name of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    const path = join(root, name)
    if (await fileExists(path)) return { created: false, path, commands: {} }
  }

  const commands = await detectProjectCommands(root)
  const path = join(root, CONFIG_FILE)
  const content = `${JSON.stringify({ project: { commands } }, null, 2)}\n`

  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" })
    return { created: true, path, commands }
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return { created: false, path, commands: {} }
    throw error
  }
}

export async function detectProjectCommands(cwd = process.cwd()): Promise<ProjectCommands> {
  const root = resolve(cwd)
  const commands: ProjectCommands = {}
  const packageManifest = await readPackageManifest(root)
  const packageManager = packageManifest ? await detectPackageManager(root, packageManifest.packageManager) : undefined

  if (packageManifest && packageManager) {
    const scripts = isRecord(packageManifest.scripts) ? packageManifest.scripts : {}
    for (const name of COMMAND_NAMES) {
      if (typeof scripts[name] === "string" && scripts[name].trim()) commands[name] = `${packageManager} run ${name}`
    }
    if (!commands.typecheck && hasDependency(packageManifest, "typescript") && await fileExists(join(root, "tsconfig.json"))) {
      commands.typecheck = typescriptCommand(packageManager)
    }
  }

  const denoManifest = await readJsonObject(join(root, "deno.json"), "deno.json")
    ?? await readJsonObject(join(root, "deno.jsonc"), "deno.jsonc", true)
  if (denoManifest && isRecord(denoManifest.tasks)) {
    for (const name of COMMAND_NAMES) {
      if (!commands[name] && typeof denoManifest.tasks[name] === "string" && denoManifest.tasks[name].trim()) {
        commands[name] = `deno task ${name}`
      }
    }
  }

  const makefile = await readOptionalFile(join(root, "Makefile")) ?? await readOptionalFile(join(root, "makefile"))
  if (makefile) {
    for (const name of COMMAND_NAMES) {
      if (!commands[name] && new RegExp(`^${name}\\s*:`, "m").test(makefile)) commands[name] = `make ${name}`
    }
  }

  if (await fileExists(join(root, "Cargo.toml"))) {
    commands.test ??= "cargo test"
    commands.typecheck ??= "cargo check"
    commands.build ??= "cargo build"
  }
  if (await fileExists(join(root, "go.mod"))) {
    commands.test ??= "go test ./..."
    commands.build ??= "go build ./..."
  }

  const pyproject = await readOptionalFile(join(root, "pyproject.toml"))
  if (pyproject) {
    if (!commands.test && /(?:\[tool\.pytest\.|\bpytest\b)/i.test(pyproject)) commands.test = "python -m pytest"
    if (!commands.typecheck && /\[tool\.mypy(?:\.|\])/i.test(pyproject)) commands.typecheck = "python -m mypy ."
    if (!commands.typecheck && /\[tool\.pyright(?:\.|\])/i.test(pyproject)) commands.typecheck = "pyright"
    if (!commands.build && /\[build-system\]/i.test(pyproject)) commands.build = "python -m build"
  }
  if (!commands.test && (await fileExists(join(root, "pytest.ini")))) {
    commands.test = "python -m pytest"
  }

  return commands
}

export function formatProjectInitResult(result: ProjectInitResult): string {
  const name = basename(result.path)
  if (!result.created) return `${name} already exists; unchanged.`
  const detected = COMMAND_NAMES
    .filter((command) => result.commands[command])
    .map((command) => `- ${command}: ${result.commands[command]}`)
  return [
    `Created ${name}.`,
    detected.length ? "Detected project commands:" : "No project commands detected.",
    ...detected,
    "Run `pixiu config validate` to verify the configuration.",
  ].join("\n")
}

async function readPackageManifest(cwd: string): Promise<PackageManifest | undefined> {
  const value = await readJsonObject(join(cwd, "package.json"), "package.json")
  return value as PackageManifest | undefined
}

async function readJsonObject(path: string, label: string, jsonc = false): Promise<Record<string, unknown> | undefined> {
  const content = await readOptionalFile(path)
  if (content === undefined) return undefined
  try {
    const value = jsonc ? parseJsonc<unknown>(content, label) : JSON.parse(content) as unknown
    if (!isRecord(value)) throw new Error("expected an object")
    return value
  } catch (cause) {
    if (cause instanceof PixiuError) throw cause
    throw new PixiuError(`Invalid ${label}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      code: "CONFIG_PARSE_ERROR",
      cause,
    })
  }
}

async function detectPackageManager(cwd: string, configured: unknown): Promise<PackageManager> {
  if (typeof configured === "string") {
    const name = configured.split("@")[0]
    if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") return name
  }
  const lockfiles: Array<[PackageManager, string[]]> = [
    ["bun", ["bun.lock", "bun.lockb"]],
    ["pnpm", ["pnpm-lock.yaml"]],
    ["yarn", ["yarn.lock"]],
    ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
  ]
  for (const [manager, names] of lockfiles) {
    if ((await Promise.all(names.map((name) => fileExists(join(cwd, name))))).some(Boolean)) return manager
  }
  return "npm"
}

function typescriptCommand(manager: PackageManager): string {
  if (manager === "bun") return "bunx tsc --noEmit"
  if (manager === "pnpm") return "pnpm exec tsc --noEmit"
  if (manager === "yarn") return "yarn exec tsc --noEmit"
  return "npx tsc --noEmit"
}

function hasDependency(manifest: PackageManifest, name: string): boolean {
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
    .some((dependencies) => isRecord(dependencies) && typeof dependencies[name] === "string")
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false
    throw error
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

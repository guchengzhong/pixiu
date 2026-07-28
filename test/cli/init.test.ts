import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { detectProjectCommands, initializeProject } from "../../src/cli/init"
import { loadConfig } from "../../src/config/loader"

const CLI_ENTRY = resolve(import.meta.dir, "../../src/cli/index.ts")

describe("pixiu init", () => {
  test("detects package scripts with the configured package manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-init-package-"))
    await writeFile(join(root, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { test: "vitest", typecheck: "tsc --noEmit", build: "vite build" },
    }), "utf8")

    expect(await detectProjectCommands(root)).toEqual({
      test: "pnpm run test",
      typecheck: "pnpm run typecheck",
      build: "pnpm run build",
    })
  })

  test("uses conservative manifest fallbacks for projects without package scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-init-fallback-"))
    await writeFile(join(root, "Makefile"), "test:\n\tgo test ./...\n", "utf8")
    await writeFile(join(root, "Cargo.toml"), "[package]\nname = \"demo\"\n", "utf8")

    expect(await detectProjectCommands(root)).toEqual({
      test: "make test",
      typecheck: "cargo check",
      build: "cargo build",
    })
  })

  test("creates a minimal config once and leaves it unchanged on repeat", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-init-create-"))
    await writeFile(join(root, "package.json"), JSON.stringify({
      packageManager: "bun@1.3.14",
      scripts: { test: "bun test", typecheck: "tsc --noEmit" },
    }), "utf8")

    const first = await initializeProject(root)
    expect(first.created).toBe(true)
    const original = await readFile(join(root, "pixiu.jsonc"), "utf8")
    expect(JSON.parse(original)).toEqual({
      project: { commands: { test: "bun run test", typecheck: "bun run typecheck" } },
    })
    expect((await loadConfig({ cwd: root })).project.commands).toEqual({
      test: "bun run test",
      typecheck: "bun run typecheck",
    })

    const second = await initializeProject(root)
    expect(second.created).toBe(false)
    expect(await readFile(join(root, "pixiu.jsonc"), "utf8")).toBe(original)
  })

  test("preserves a legacy config instead of shadowing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-init-legacy-"))
    const legacy = "{\n  // keep this comment\n  \"model\": \"legacy/model\"\n}\n"
    await writeFile(join(root, "minicode.jsonc"), legacy, "utf8")

    const result = await initializeProject(root)
    expect(result.created).toBe(false)
    expect(result.path).toBe(join(root, "minicode.jsonc"))
    expect(await readFile(join(root, "minicode.jsonc"), "utf8")).toBe(legacy)
    await expect(readFile(join(root, "pixiu.jsonc"), "utf8")).rejects.toThrow()
  })

  test("is wired through the CLI entry point", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-init-cli-"))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }), "utf8")
    const child = Bun.spawn({
      cmd: [process.execPath, "run", CLI_ENTRY, "init"],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Created pixiu.jsonc")
    expect(stdout).toContain("build: npm run build")
  })
})

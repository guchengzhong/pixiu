import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { ToolRegistry } from "../../src/tools/registry"
import { createBuiltinTools } from "../../src/tools/builtin"
import { StaticPermissionManager } from "../../src/permission/evaluator"
import { PathGuard } from "../../src/sandbox/path"

async function context(root: string, autoApprove = true) {
  return {
    cwd: root,
    workspaceRoot: root,
    permissions: new StaticPermissionManager(
      [
        { tool: "read", action: "allow" },
        { tool: "write", action: "ask" },
        { tool: "shell", action: "ask" },
      ],
      { nonInteractive: true, autoApprove },
    ),
    pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
    config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
  }
}

describe("tool registry and builtins", () => {
  test("read tool returns clear file content", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-tools-"))
    await writeFile(join(root, "note.txt"), "hello world", "utf8")
    const registry = new ToolRegistry().registerMany(createBuiltinTools())

    const result = await registry.execute("read", { path: "note.txt" }, await context(root))
    expect(result.ok).toBe(true)
    expect(result.content).toContain("hello world")
  })

  test("invalid input returns model-correctable error", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-tools-"))
    const registry = new ToolRegistry().registerMany(createBuiltinTools())

    const result = await registry.execute("read", {}, await context(root))
    expect(result.ok).toBe(false)
    expect(result.content).toContain("missing required field")
  })

  test("write is denied without auto approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-tools-"))
    const registry = new ToolRegistry().registerMany(createBuiltinTools())

    const result = await registry.execute("write", { path: "a.txt", content: "x" }, await context(root, false))
    expect(result.ok).toBe(false)
    expect(result.content).toContain("Permission denied")
    expect(result.metadata?.permissionAction).toBe("deny")
    expect(result.metadata?.permissionOriginalAction).toBe("ask")
  })

  test("outside workspace paths trigger permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-tools-"))
    const outside = join(tmpdir(), "minicode-outside.txt")
    await writeFile(outside, "secret", "utf8")
    const registry = new ToolRegistry().registerMany(createBuiltinTools())

    const result = await registry.execute("read", { path: outside }, await context(root, false))
    expect(result.ok).toBe(false)
    expect(result.content).toContain("outside-workspace")
  })

  test("shell audit metadata includes risk, permission, cwd, duration, and output sizes", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-tools-shell-audit-"))
    const registry = new ToolRegistry().registerMany(createBuiltinTools())

    const result = await registry.execute("shell", { command: "printf hello" }, await context(root))

    expect(result.ok).toBe(true)
    expect(result.content).toContain("hello")
    expect(result.metadata).toMatchObject({
      command: "printf hello",
      cwd: root,
      exitCode: 0,
      timedOut: false,
      permissionAction: "allow",
      permissionOriginalAction: "ask",
      shellRisk: "low",
      shellRiskCategory: "read",
    })
    expect(typeof result.metadata?.durationMs).toBe("number")
    expect(result.metadata?.stdoutBytes).toBe(5)
  })

  test("shell denies obvious writes outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-tools-shell-outside-"))
    const registry = new ToolRegistry().registerMany(createBuiltinTools())

    const result = await registry.execute("shell", { command: "printf bad > ../outside.txt" }, await context(root))

    expect(result.ok).toBe(false)
    expect(result.content).toContain("outside the workspace")
    expect(result.metadata?.outsideWorkspaceTarget).toBe("../outside.txt")
  })

  test("shell can write temporary files under .minicode/tmp", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-tools-shell-tmp-"))
    const registry = new ToolRegistry().registerMany(createBuiltinTools())

    const result = await registry.execute(
      "shell",
      { command: "mkdir -p .minicode/tmp && printf tmp-ok > .minicode/tmp/a.txt" },
      await context(root),
    )

    expect(result.ok).toBe(true)
    expect(await readFile(join(root, ".minicode/tmp/a.txt"), "utf8")).toBe("tmp-ok")
  })

  test("shell env allowlist does not expose provider API keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-tools-shell-env-"))
    const previous = process.env.MINICODE_API_KEY
    process.env.MINICODE_API_KEY = "sk-test-secret-1234567890"
    try {
      const registry = new ToolRegistry().registerMany(createBuiltinTools())
      const result = await registry.execute("shell", { command: "env | grep MINICODE_API_KEY || true" }, await context(root))

      expect(result.ok).toBe(true)
      expect(result.content).not.toContain("MINICODE_API_KEY")
      expect(result.content).not.toContain("sk-test-secret")
    } finally {
      if (previous === undefined) delete process.env.MINICODE_API_KEY
      else process.env.MINICODE_API_KEY = previous
    }
  })
})

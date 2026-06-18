import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { classifyShellCommand, findOutsideWorkspaceShellWrite, runShell } from "../../src/sandbox/shell"

describe("shell sandbox helpers", () => {
  test("classifies command risk", () => {
    expect(classifyShellCommand("ls -la")).toMatchObject({ risk: "low", category: "read" })
    expect(classifyShellCommand("curl https://example.test")).toMatchObject({ risk: "high", category: "network" })
    expect(classifyShellCommand("npm install left-pad")).toMatchObject({ risk: "high", category: "package" })
    expect(classifyShellCommand("git reset --hard")).toMatchObject({ risk: "medium", category: "git" })
    expect(classifyShellCommand("rm -rf build")).toMatchObject({ risk: "high", category: "delete" })
  })

  test("detects obvious outside-workspace shell writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-shell-helper-"))

    expect(findOutsideWorkspaceShellWrite("printf nope > ../outside.txt", root)).toBe("../outside.txt")
    expect(findOutsideWorkspaceShellWrite("printf ok > .pixiu/tmp/a.txt", root)).toBeUndefined()
    expect(findOutsideWorkspaceShellWrite("browser-use close >/dev/null 2>&1", root)).toBeUndefined()
  })

  test("prepends managed environment bin path for shell commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-shell-path-"))
    const bin = join(root, "managed-bin")
    await mkdir(bin)
    const commandPath = join(bin, "pixiu-managed-hello")
    await writeFile(commandPath, "#!/bin/sh\nprintf managed-ok\n", "utf8")
    await chmod(commandPath, 0o755)

    const result = await runShell("pixiu-managed-hello", {
      cwd: root,
      timeoutMs: 500,
      outputMaxBytes: 4_000,
      envAllowlist: ["PATH"],
      envPrependPath: [bin],
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("managed-ok")
  })

  test("applies explicit safe environment overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-shell-env-"))
    const result = await runShell("printf \"$PYTHONNOUSERSITE\"", {
      cwd: root,
      timeoutMs: 500,
      outputMaxBytes: 4_000,
      envAllowlist: ["PATH"],
      envOverrides: { PYTHONNOUSERSITE: "1" },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("1")
  })

  test("passes allowed desktop session variables to shell commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-shell-display-"))
    const previous = process.env.DISPLAY
    process.env.DISPLAY = ":42"
    try {
      const result = await runShell("printf \"$DISPLAY\"", {
        cwd: root,
        timeoutMs: 500,
        outputMaxBytes: 4_000,
        envAllowlist: ["PATH", "DISPLAY"],
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(":42")
    } finally {
      if (previous === undefined) delete process.env.DISPLAY
      else process.env.DISPLAY = previous
    }
  })
})

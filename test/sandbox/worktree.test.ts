import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runShell } from "../../src/sandbox/shell"
import { createWorktreeSandbox } from "../../src/sandbox/worktree"

async function gitAvailable() {
  const result = await runShell("git --version", { cwd: process.cwd(), timeoutMs: 2_000, outputMaxBytes: 1_000, envAllowlist: ["PATH"] })
  return result.exitCode === 0
}

describe("worktree sandbox", () => {
  test("creates and cleans a git worktree sandbox", async () => {
    if (!(await gitAvailable())) return
    const repo = await mkdtemp(join(tmpdir(), "minicode-repo-"))
    const shellOptions = { cwd: repo, timeoutMs: 5_000, outputMaxBytes: 4_000, envAllowlist: ["PATH", "HOME"] }
    expect((await runShell("git init", shellOptions)).exitCode).toBe(0)
    await runShell("git config user.email test@example.com", shellOptions)
    await runShell("git config user.name minicode", shellOptions)
    await writeFile(join(repo, "README.md"), "hello", "utf8")
    expect((await runShell("git add README.md", shellOptions)).exitCode).toBe(0)
    expect((await runShell("git commit -m init", shellOptions)).exitCode).toBe(0)

    const sandbox = await createWorktreeSandbox(repo, "minicode-test")
    expect(sandbox.path).toContain("minicode-test-worktree")
    await sandbox.cleanup()
  })
})

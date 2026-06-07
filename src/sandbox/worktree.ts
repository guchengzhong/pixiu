import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runShell } from "./shell"
import { MinicodeError } from "../shared/errors"

export type WorktreeSandbox = {
  path: string
  branch: string
  cleanup(): Promise<void>
}

export async function createWorktreeSandbox(repo: string, prefix = "minicode") {
  const path = await mkdtemp(join(tmpdir(), `${prefix}-worktree-`))
  const branch = `${prefix}/${Date.now().toString(36)}`
  const result = await runShell(`git worktree add -b ${branch} ${JSON.stringify(path)}`, {
    cwd: repo,
    timeoutMs: 30_000,
    outputMaxBytes: 8_000,
    envAllowlist: ["PATH", "HOME"],
  })
  if (result.exitCode !== 0) {
    await rm(path, { recursive: true, force: true })
    throw new MinicodeError(`Failed to create worktree sandbox: ${result.stderr || result.stdout}`, {
      code: "WORKTREE_CREATE_FAILED",
    })
  }
  return {
    path,
    branch,
    async cleanup() {
      await runShell(`git worktree remove --force ${JSON.stringify(path)}`, {
        cwd: repo,
        timeoutMs: 30_000,
        outputMaxBytes: 8_000,
        envAllowlist: ["PATH", "HOME"],
      })
      await runShell(`git branch -D ${JSON.stringify(branch)}`, {
        cwd: repo,
        timeoutMs: 30_000,
        outputMaxBytes: 8_000,
        envAllowlist: ["PATH", "HOME"],
      })
      await rm(path, { recursive: true, force: true })
    },
  } satisfies WorktreeSandbox
}

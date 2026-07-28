import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import {
  createSessionWorkspaceBinding,
  loadSessionWorkspaceBinding,
  resolveSessionWorkspacePath,
  sessionWorkspaceBindingPath,
} from "../../src/workspace/session"

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pixiu-workspace-${name}-`))
  const projectRoot = join(root, "project")
  const stateRoot = join(root, "state")
  await mkdir(projectRoot)
  return { root, projectRoot, stateRoot }
}

async function runGit(root: string, ...args: string[]) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

describe("persistent session workspace binding", () => {
  test("creates baseline, work, and metadata outside a non-Git project", async () => {
    const { root, projectRoot, stateRoot } = await fixture("directory")
    await mkdir(join(projectRoot, "src"))
    await mkdir(join(projectRoot, "node_modules/pkg"), { recursive: true })
    await mkdir(join(projectRoot, ".pixiu"))
    await mkdir(join(projectRoot, ".tools/bun/bin"), { recursive: true })
    await mkdir(join(projectRoot, ".venv/bin"), { recursive: true })
    await writeFile(join(projectRoot, "src/main.ts"), "export const value = 1\n")
    await writeFile(join(projectRoot, ".hidden"), "included\n")
    await writeFile(join(projectRoot, "pwd"), "dummy-secret-that-must-not-be-copied\n")
    await writeFile(join(projectRoot, "node_modules/pkg/index.js"), "excluded\n")
    await writeFile(join(projectRoot, ".pixiu/private.json"), "excluded\n")
    const externalTool = join(root, "external-bun")
    await writeFile(externalTool, "tool binary placeholder\n")
    await symlink(externalTool, join(projectRoot, ".tools/bun/bin/bunx"))
    await symlink(externalTool, join(projectRoot, ".venv/bin/python"))

    const binding = await createSessionWorkspaceBinding({
      stateRoot,
      projectRoot,
      sessionId: "session_directory",
      projectId: "project_one",
    })

    expect(binding.source).toEqual({ kind: "directory" })
    expect(binding.root.startsWith(stateRoot)).toBe(true)
    expect(binding.root.startsWith(projectRoot)).toBe(false)
    expect(await readFile(join(binding.baselineRoot, "src/main.ts"), "utf8")).toBe("export const value = 1\n")
    expect(await readFile(join(binding.workRoot, "src/main.ts"), "utf8")).toBe("export const value = 1\n")
    expect(await readFile(join(binding.workRoot, ".hidden"), "utf8")).toBe("included\n")
    await expect(lstat(join(binding.workRoot, "node_modules"))).rejects.toThrow()
    await expect(lstat(join(binding.workRoot, ".pixiu"))).rejects.toThrow()
    await expect(lstat(join(binding.baselineRoot, ".tools"))).rejects.toThrow()
    await expect(lstat(join(binding.workRoot, ".tools"))).rejects.toThrow()
    await expect(lstat(join(binding.baselineRoot, ".venv"))).rejects.toThrow()
    await expect(lstat(join(binding.workRoot, ".venv"))).rejects.toThrow()
    await expect(lstat(join(binding.baselineRoot, "pwd"))).rejects.toThrow()
    await expect(lstat(join(binding.workRoot, "pwd"))).rejects.toThrow()
    expect((await lstat(binding.baselineRoot)).mode & 0o222).toBe(0)
    expect((await lstat(join(binding.baselineRoot, "src/main.ts"))).mode & 0o222).toBe(0)

    await writeFile(join(binding.workRoot, "src/main.ts"), "export const value = 2\n")
    expect(await readFile(join(projectRoot, "src/main.ts"), "utf8")).toBe("export const value = 1\n")
    expect(await readFile(join(binding.baselineRoot, "src/main.ts"), "utf8")).toBe("export const value = 1\n")

    const loaded = await loadSessionWorkspaceBinding({ stateRoot, projectRoot, sessionId: binding.sessionId })
    expect(loaded).toEqual(binding)
  })

  test("captures dirty and untracked Git content without changing the project index", async () => {
    const { projectRoot, stateRoot } = await fixture("git")
    await runGit(projectRoot, "init")
    await runGit(projectRoot, "config", "user.email", "pixiu@example.test")
    await runGit(projectRoot, "config", "user.name", "Pixiu Test")
    await writeFile(join(projectRoot, "tracked.txt"), "base\n")
    await runGit(projectRoot, "add", "tracked.txt")
    await runGit(projectRoot, "commit", "-m", "base")
    await writeFile(join(projectRoot, "tracked.txt"), "dirty\n")
    await writeFile(join(projectRoot, "untracked.txt"), "new\n")
    const statusBefore = await runGit(projectRoot, "status", "--porcelain=v1")

    const binding = await createSessionWorkspaceBinding({ stateRoot, projectRoot, sessionId: "session_git" })

    expect(binding.source.kind).toBe("git")
    if (binding.source.kind === "git") {
      expect(binding.source.repositoryRoot).toBe(projectRoot)
      expect(binding.source.head).toMatch(/^[0-9a-f]{40,64}$/)
    }
    expect(await readFile(join(binding.workRoot, "tracked.txt"), "utf8")).toBe("dirty\n")
    expect(await readFile(join(binding.workRoot, "untracked.txt"), "utf8")).toBe("new\n")
    expect(await runGit(projectRoot, "status", "--porcelain=v1")).toBe(statusBefore)
  })

  test("rejects overlapping roots and unsafe session ids", async () => {
    const { projectRoot, stateRoot } = await fixture("roots")
    await expect(createSessionWorkspaceBinding({
      stateRoot: join(projectRoot, ".state"),
      projectRoot,
      sessionId: "session_nested",
    })).rejects.toMatchObject({ code: "SESSION_WORKSPACE_ROOT_OVERLAP" })
    await expect(createSessionWorkspaceBinding({
      stateRoot,
      projectRoot,
      sessionId: "../escape",
    })).rejects.toMatchObject({ code: "SESSION_WORKSPACE_ID_INVALID" })
  })

  test("rejects project symlinks that escape and leaves no completed binding", async () => {
    const { root, projectRoot, stateRoot } = await fixture("source-symlink")
    const outside = join(root, "outside.txt")
    await writeFile(outside, "secret\n")
    await symlink(outside, join(projectRoot, "escape.txt"))

    await expect(createSessionWorkspaceBinding({
      stateRoot,
      projectRoot,
      sessionId: "session_escape",
    })).rejects.toMatchObject({ code: "WORKSPACE_SYMLINK_UNSAFE" })
    await expect(lstat(sessionWorkspaceBindingPath({ stateRoot, projectRoot, sessionId: "session_escape" }))).rejects.toThrow()
  })

  test("does not follow symlinks planted below the state root", async () => {
    const { root, projectRoot, stateRoot } = await fixture("state-symlink")
    const outside = join(root, "outside-state")
    await mkdir(stateRoot)
    await mkdir(outside)
    await symlink(outside, join(stateRoot, "projects"))

    await expect(createSessionWorkspaceBinding({
      stateRoot,
      projectRoot,
      sessionId: "session_state_escape",
    })).rejects.toMatchObject({ code: "SESSION_WORKSPACE_STATE_UNSAFE" })
  })

  test("copies safe relative symlinks but refuses to resolve through them", async () => {
    const { projectRoot, stateRoot } = await fixture("safe-symlink")
    await mkdir(join(projectRoot, "src"))
    await writeFile(join(projectRoot, "src/target.txt"), "inside\n")
    await symlink("target.txt", join(projectRoot, "src/link.txt"))
    const binding = await createSessionWorkspaceBinding({ stateRoot, projectRoot, sessionId: "session_link" })

    expect((await lstat(join(binding.workRoot, "src/link.txt"))).isSymbolicLink()).toBe(true)
    await expect(resolveSessionWorkspacePath(binding, "work", "src/link.txt")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_SYMLINK",
    })
    await expect(resolveSessionWorkspacePath(binding, "work", "../project/secret.txt", { allowMissing: true })).rejects.toMatchObject({
      code: "WORKSPACE_PATH_INVALID",
    })
    expect(await resolveSessionWorkspacePath(binding, "work", "src/new.txt", { allowMissing: true })).toMatchObject({
      relativePath: "src/new.txt",
    })
  })

  test("detects baseline tampering and replacement of the bound project root", async () => {
    const { root, projectRoot, stateRoot } = await fixture("tamper")
    await writeFile(join(projectRoot, "note.txt"), "original\n")
    const binding = await createSessionWorkspaceBinding({ stateRoot, projectRoot, sessionId: "session_tamper" })
    const baselineFile = join(binding.baselineRoot, "note.txt")
    await chmod(dirname(baselineFile), 0o700)
    await chmod(baselineFile, 0o600)
    await writeFile(baselineFile, "tampered\n")

    await expect(loadSessionWorkspaceBinding({ stateRoot, projectRoot, sessionId: binding.sessionId })).rejects.toMatchObject({
      code: "SESSION_WORKSPACE_BASELINE_CHANGED",
    })

    const replacementSource = join(root, "replacement")
    await mkdir(replacementSource)
    await rename(projectRoot, join(root, "old-project"))
    await rename(replacementSource, projectRoot)
    await expect(loadSessionWorkspaceBinding({
      stateRoot,
      projectRoot,
      sessionId: binding.sessionId,
      verifyBaseline: false,
    })).rejects.toMatchObject({ code: "SESSION_WORKSPACE_PROJECT_REPLACED" })
  })
})

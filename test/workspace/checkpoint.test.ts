import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createWorkspaceCheckpoint, loadWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from "../../src/workspace/checkpoint"
import { createSessionWorkspaceBinding } from "../../src/workspace/session"

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pixiu-checkpoint-${name}-`))
  const projectRoot = join(root, "project")
  const stateRoot = join(root, "state")
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, "note.txt"), "baseline\n")
  const binding = await createSessionWorkspaceBinding({ stateRoot, projectRoot, sessionId: `session_${name}` })
  return { root, binding }
}

describe("workspace checkpoints", () => {
  test("restores the session work tree without touching project or baseline", async () => {
    const { binding } = await fixture("restore")
    await writeFile(join(binding.workRoot, "note.txt"), "before turn\n")
    await writeFile(join(binding.workRoot, "keep.txt"), "keep\n")
    const checkpoint = await createWorkspaceCheckpoint(binding, "turn_restore")

    await writeFile(join(binding.workRoot, "note.txt"), "during turn\n")
    await rm(join(binding.workRoot, "keep.txt"))
    await writeFile(join(binding.workRoot, "new.txt"), "new\n")
    await restoreWorkspaceCheckpoint(binding, checkpoint.id)

    expect(await readFile(join(binding.workRoot, "note.txt"), "utf8")).toBe("before turn\n")
    expect(await readFile(join(binding.workRoot, "keep.txt"), "utf8")).toBe("keep\n")
    expect(await Bun.file(join(binding.workRoot, "new.txt")).exists()).toBe(false)
    expect(await readFile(join(binding.projectRoot, "note.txt"), "utf8")).toBe("baseline\n")
    expect(await readFile(join(binding.baselineRoot, "note.txt"), "utf8")).toBe("baseline\n")
    expect(await loadWorkspaceCheckpoint(binding, checkpoint.id)).toEqual(checkpoint)
  })

  test("rejects unsafe ids and checkpoint trees replaced by symlinks", async () => {
    const { root, binding } = await fixture("unsafe")
    const checkpoint = await createWorkspaceCheckpoint(binding, "turn_safe")
    await expect(loadWorkspaceCheckpoint(binding, "../outside")).rejects.toMatchObject({ code: "CHECKPOINT_ID_INVALID" })

    const tree = join(binding.root, "checkpoints", checkpoint.id, "tree")
    await rm(tree, { recursive: true })
    await symlink(root, tree)
    await expect(restoreWorkspaceCheckpoint(binding, checkpoint.id)).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" })
  })
})

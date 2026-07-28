import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { structuredWorkspaceDiff, workspaceRevision } from "../../src/workspace/diff"

async function roots(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pixiu-diff-${name}-`))
  const baseline = join(root, "baseline")
  const work = join(root, "work")
  await mkdir(baseline)
  await mkdir(work)
  return { root, baseline, work }
}

describe("structured workspace diff", () => {
  test("returns stable revisions for identical directories", async () => {
    const { baseline, work } = await roots("clean")
    await writeFile(join(baseline, "same.txt"), "same\n")
    await writeFile(join(work, "same.txt"), "same\n")

    const result = await structuredWorkspaceDiff(baseline, work)

    expect(result.files).toEqual([])
    expect(result.baseRevision).toBe(result.workRevision)
    expect(result.baseRevision).toBe(await workspaceRevision(baseline))
    expect((await structuredWorkspaceDiff(baseline, work)).revision).toBe(result.revision)
  })

  test("builds stable, separated hunks with line coordinates", async () => {
    const { baseline, work } = await roots("hunks")
    const before = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", ""].join("\n")
    const after = ["one", "TWO", "three", "four", "five", "six", "seven", "eight", "NINE", "ten", ""].join("\n")
    await writeFile(join(baseline, "note.txt"), before)
    await writeFile(join(work, "note.txt"), after)

    const first = await structuredWorkspaceDiff(baseline, work, { contextLines: 1 })
    const second = await structuredWorkspaceDiff(baseline, work, { contextLines: 1 })
    const file = first.files[0]!

    expect(file).toMatchObject({ path: "note.txt", status: "modified", binary: false, additions: 2, deletions: 2 })
    expect(file.hunks).toHaveLength(2)
    expect(file.hunks[0]?.patch).toContain("-two\n+TWO")
    expect(file.hunks[1]?.patch).toContain("-nine\n+NINE")
    expect(file.hunks.map((hunk) => hunk.id)).toEqual(second.files[0]!.hunks.map((hunk) => hunk.id))
    expect(new Set(file.hunks.map((hunk) => hunk.id)).size).toBe(2)
  })

  test("reports added, deleted, executable-only, and type changes", async () => {
    const { baseline, work } = await roots("statuses")
    await writeFile(join(baseline, "deleted.txt"), "gone\n")
    await writeFile(join(baseline, "mode.sh"), "echo ok\n", { mode: 0o644 })
    await writeFile(join(baseline, "type"), "file\n")
    await writeFile(join(work, "added.txt"), "new\n")
    await writeFile(join(work, "mode.sh"), "echo ok\n", { mode: 0o755 })
    await symlink("mode.sh", join(work, "type"))
    await chmod(join(work, "mode.sh"), 0o755)

    const result = await structuredWorkspaceDiff(baseline, work)
    const byPath = new Map(result.files.map((file) => [file.path, file]))

    expect(byPath.get("added.txt")).toMatchObject({ status: "added", additions: 1, deletions: 0 })
    expect(byPath.get("deleted.txt")).toMatchObject({ status: "deleted", additions: 0, deletions: 1 })
    expect(byPath.get("mode.sh")).toMatchObject({ status: "modified", oldMode: "100644", newMode: "100755", hunks: [] })
    expect(byPath.get("type")).toMatchObject({ status: "type-changed", oldKind: "file", newKind: "symlink", hunksUnavailableReason: "type-changed" })
  })

  test("does not read binary, oversized, or escaping symlink targets", async () => {
    const { root, baseline, work } = await roots("opaque")
    await writeFile(join(baseline, "binary.dat"), new Uint8Array([0, 1, 2]))
    await writeFile(join(work, "binary.dat"), new Uint8Array([0, 1, 3]))
    await writeFile(join(baseline, "large.txt"), "old old old\n")
    await writeFile(join(work, "large.txt"), "new new new\n")
    const secret = join(root, "secret.txt")
    await writeFile(secret, "DO_NOT_READ_THIS_SECRET\n")
    await symlink("../secret.txt", join(work, "escape.txt"))
    await symlink("escape.txt", join(work, "escape-chain.txt"))

    const result = await structuredWorkspaceDiff(baseline, work, { maxTextBytes: 4 })
    const byPath = new Map(result.files.map((file) => [file.path, file]))

    expect(byPath.get("binary.dat")).toMatchObject({ binary: true, hunksUnavailableReason: "binary", hunks: [] })
    expect(byPath.get("large.txt")).toMatchObject({ binary: false, hunksUnavailableReason: "too-large", hunks: [] })
    expect(byPath.get("escape.txt")).toMatchObject({ newKind: "symlink", unsafeSymlink: true, hunks: [] })
    expect(byPath.get("escape-chain.txt")).toMatchObject({ newKind: "symlink", unsafeSymlink: true, hunks: [] })
    expect(JSON.stringify(result)).not.toContain("DO_NOT_READ_THIS_SECRET")
  })

  test("records missing final newlines in hunk patches", async () => {
    const { baseline, work } = await roots("newline")
    await writeFile(join(baseline, "note.txt"), "before")
    await writeFile(join(work, "note.txt"), "after")

    const file = (await structuredWorkspaceDiff(baseline, work)).files[0]!

    expect(file.oldHasFinalNewline).toBe(false)
    expect(file.newHasFinalNewline).toBe(false)
    expect(file.hunks[0]?.patch).toContain("\\ No newline at end of file")
  })

  test("rejects a symlink as the workspace root", async () => {
    const { root, baseline, work } = await roots("root-symlink")
    const linked = join(root, "linked-work")
    await symlink(work, linked)

    await expect(structuredWorkspaceDiff(baseline, linked)).rejects.toMatchObject({ code: "WORKSPACE_ROOT_INVALID" })
  })
})

import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  applySessionWorkspaceChanges,
  discardSessionWorkspaceChanges,
  readSessionWorkspaceApplyState,
  undoLastSessionWorkspaceApply,
} from "../../src/workspace/apply"
import { structuredWorkspaceDiff } from "../../src/workspace/diff"
import { createSessionWorkspaceBinding, loadSessionWorkspaceBinding } from "../../src/workspace/session"

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pixiu-apply-${name}-`))
  const projectRoot = join(root, "project")
  const stateRoot = join(root, "state")
  await mkdir(projectRoot)
  return { root, projectRoot, stateRoot }
}

async function bindingFixture(name: string, files: Record<string, string | Uint8Array>) {
  const roots = await fixture(name)
  for (const [path, content] of Object.entries(files)) {
    const target = join(roots.projectRoot, path)
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(target, content)
  }
  const binding = await createSessionWorkspaceBinding({
    stateRoot: roots.stateRoot,
    projectRoot: roots.projectRoot,
    sessionId: `session_${name.replaceAll("-", "_")}`,
  })
  return { ...roots, binding }
}

async function diffFor(binding: Awaited<ReturnType<typeof createSessionWorkspaceBinding>>) {
  return await structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot)
}

function separatedText(first: string, second: string) {
  return [
    "line-01",
    first,
    "line-03",
    "line-04",
    "line-05",
    "line-06",
    "line-07",
    "line-08",
    "line-09",
    "line-10",
    "line-11",
    "line-12",
    "line-13",
    second,
    "line-15",
    "",
  ].join("\n")
}

describe("session workspace change application", () => {
  test("applies a whole file and persistently restores its exact project state with undo", async () => {
    const { projectRoot, stateRoot, binding } = await bindingFixture("whole", { "script.sh": "old\n" })
    await chmod(join(projectRoot, "script.sh"), 0o600)
    await writeFile(join(binding.workRoot, "script.sh"), "new\n")
    await chmod(join(binding.workRoot, "script.sh"), 0o700)
    const diff = await diffFor(binding)

    const applied = await applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "script.sh" }],
    })

    expect(applied.operation).toMatchObject({ action: "apply", paths: ["script.sh"] })
    expect(applied.canUndo).toBe(true)
    expect(await readFile(join(projectRoot, "script.sh"), "utf8")).toBe("new\n")
    expect((await lstat(join(projectRoot, "script.sh"))).mode & 0o777).toBe(0o755)
    expect(await readFile(join(binding.baselineRoot, "script.sh"), "utf8")).toBe("old\n")
    expect(await readFile(join(binding.workRoot, "script.sh"), "utf8")).toBe("new\n")

    const state = await readSessionWorkspaceApplyState(binding)
    expect(state).toMatchObject({ canUndo: true, lastApplyId: applied.operation.id })
    expect(state.operations.map((operation) => operation.action)).toEqual(["apply"])

    const loaded = await loadSessionWorkspaceBinding({ stateRoot, projectRoot, sessionId: binding.sessionId })
    const undone = await undoLastSessionWorkspaceApply(loaded, { revision: diff.revision })
    expect(undone.operation).toMatchObject({ action: "undo", applyId: applied.operation.id })
    expect(undone.canUndo).toBe(false)
    expect(await readFile(join(projectRoot, "script.sh"), "utf8")).toBe("old\n")
    expect((await lstat(join(projectRoot, "script.sh"))).mode & 0o777).toBe(0o600)
    await expect(undoLastSessionWorkspaceApply(loaded, { revision: diff.revision })).rejects.toMatchObject({
      code: "WORKSPACE_UNDO_EMPTY",
    })
  })

  test("cumulatively applies selected hunks and undoes them in global LIFO order", async () => {
    const baseline = separatedText("old-a", "old-b")
    const work = separatedText("new-a", "new-b")
    const { projectRoot, binding } = await bindingFixture("hunks", { "note.txt": baseline })
    await writeFile(join(binding.workRoot, "note.txt"), work)
    const diff = await diffFor(binding)
    const file = diff.files.find((entry) => entry.path === "note.txt")!
    expect(file.hunks).toHaveLength(2)
    const [first, second] = file.hunks

    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt", hunkIds: [] }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_SELECTION_INVALID" })
    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt", hunkIds: ["0".repeat(64)] }],
    })).rejects.toMatchObject({ code: "WORKSPACE_HUNK_NOT_FOUND" })

    const firstApply = await applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt", hunkIds: [first!.id] }],
    })
    expect(await readFile(join(projectRoot, "note.txt"), "utf8")).toBe(separatedText("new-a", "old-b"))

    const secondApply = await applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt", hunkIds: [second!.id] }],
    })
    expect(await readFile(join(projectRoot, "note.txt"), "utf8")).toBe(work)

    const undoSecond = await undoLastSessionWorkspaceApply(binding, { revision: diff.revision })
    expect(undoSecond.operation.applyId).toBe(secondApply.operation.id)
    expect(await readFile(join(projectRoot, "note.txt"), "utf8")).toBe(separatedText("new-a", "old-b"))
    const undoFirst = await undoLastSessionWorkspaceApply(binding, { revision: diff.revision })
    expect(undoFirst.operation.applyId).toBe(firstApply.operation.id)
    expect(await readFile(join(projectRoot, "note.txt"), "utf8")).toBe(baseline)
  })

  test("discards one hunk or a whole file only from session work", async () => {
    const baseline = separatedText("old-a", "old-b")
    const { projectRoot, binding } = await bindingFixture("discard", { "note.txt": baseline })
    await writeFile(join(binding.workRoot, "note.txt"), separatedText("new-a", "new-b"))
    const initial = await diffFor(binding)
    const first = initial.files[0]!.hunks[0]!

    const partial = await discardSessionWorkspaceChanges(binding, {
      revision: initial.revision,
      selections: [{ path: "note.txt", hunkIds: [first.id] }],
    })
    expect(await readFile(join(binding.workRoot, "note.txt"), "utf8")).toBe(separatedText("old-a", "new-b"))
    expect(await readFile(join(projectRoot, "note.txt"), "utf8")).toBe(baseline)
    expect(partial.revision).not.toBe(initial.revision)

    await discardSessionWorkspaceChanges(binding, {
      revision: partial.revision,
      selections: [{ path: "note.txt" }],
    })
    expect(await readFile(join(binding.workRoot, "note.txt"), "utf8")).toBe(baseline)
    const state = await readSessionWorkspaceApplyState(binding)
    expect(state.canUndo).toBe(false)
    expect(state.operations.map((operation) => operation.action)).toEqual(["discard", "discard"])
  })

  test("atomically applies and undoes added, deleted, and binary files", async () => {
    const originalBinary = new Uint8Array([0, 1, 2, 3])
    const changedBinary = new Uint8Array([0, 9, 8, 7])
    const { projectRoot, binding } = await bindingFixture("file-kinds", {
      "delete.txt": "remove me\n",
      "binary.dat": originalBinary,
    })
    await rm(join(binding.workRoot, "delete.txt"))
    await writeFile(join(binding.workRoot, "binary.dat"), changedBinary)
    await mkdir(join(binding.workRoot, "new/deep"), { recursive: true })
    await writeFile(join(binding.workRoot, "new/deep/added.bin"), new Uint8Array([0, 5, 6]))
    const diff = await diffFor(binding)

    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "binary.dat", hunkIds: ["0".repeat(64)] }],
    })).rejects.toMatchObject({ code: "WORKSPACE_HUNKS_UNAVAILABLE" })

    await mkdir(join(projectRoot, "new/deep"), { recursive: true })
    await writeFile(join(projectRoot, "new/deep/added.bin"), "external\n")
    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "new/deep/added.bin" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_CONFLICT" })
    expect(await readFile(join(projectRoot, "new/deep/added.bin"), "utf8")).toBe("external\n")
    await rm(join(projectRoot, "new/deep/added.bin"))

    await writeFile(join(projectRoot, "delete.txt"), "external\n")
    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "delete.txt" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_CONFLICT" })
    expect(await readFile(join(projectRoot, "delete.txt"), "utf8")).toBe("external\n")
    await writeFile(join(projectRoot, "delete.txt"), "remove me\n")

    const applied = await applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [
        { path: "new/deep/added.bin" },
        { path: "delete.txt" },
        { path: "binary.dat" },
      ],
    })
    expect(applied.operation.paths).toEqual(["binary.dat", "delete.txt", "new/deep/added.bin"])
    expect(new Uint8Array(await readFile(join(projectRoot, "binary.dat")))).toEqual(changedBinary)
    await expect(lstat(join(projectRoot, "delete.txt"))).rejects.toThrow()
    expect(new Uint8Array(await readFile(join(projectRoot, "new/deep/added.bin")))).toEqual(new Uint8Array([0, 5, 6]))

    await undoLastSessionWorkspaceApply(binding, { revision: diff.revision })
    expect(new Uint8Array(await readFile(join(projectRoot, "binary.dat")))).toEqual(originalBinary)
    expect(await readFile(join(projectRoot, "delete.txt"), "utf8")).toBe("remove me\n")
    await expect(lstat(join(projectRoot, "new/deep/added.bin"))).rejects.toThrow()

    const discarded = await discardSessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [
        { path: "new/deep/added.bin" },
        { path: "delete.txt" },
        { path: "binary.dat" },
      ],
    })
    expect((await diffFor(binding)).files).toEqual([])
    expect(discarded.revision).toBe((await diffFor(binding)).revision)
    expect(new Uint8Array(await readFile(join(binding.workRoot, "binary.dat")))).toEqual(originalBinary)
    expect(await readFile(join(binding.workRoot, "delete.txt"), "utf8")).toBe("remove me\n")
    await expect(lstat(join(binding.workRoot, "new/deep/added.bin"))).rejects.toThrow()
  })

  test("rejects stale source revisions and project conflicts before writing any selected path", async () => {
    const { projectRoot, binding } = await bindingFixture("conflict", {
      "a.txt": "a0\n",
      "b.txt": "b0\n",
    })
    await writeFile(join(binding.workRoot, "a.txt"), "a1\n")
    await writeFile(join(binding.workRoot, "b.txt"), "b1\n")
    const stale = await diffFor(binding)
    await writeFile(join(binding.workRoot, "a.txt"), "a2\n")

    await expect(applySessionWorkspaceChanges(binding, {
      revision: stale.revision,
      selections: [{ path: "a.txt" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_STALE" })
    await expect(discardSessionWorkspaceChanges(binding, {
      revision: stale.revision,
      selections: [{ path: "a.txt" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_STALE" })
    expect(await readFile(join(projectRoot, "a.txt"), "utf8")).toBe("a0\n")

    const current = await diffFor(binding)
    await writeFile(join(projectRoot, "b.txt"), "external\n")
    await expect(applySessionWorkspaceChanges(binding, {
      revision: current.revision,
      selections: [{ path: "a.txt" }, { path: "b.txt" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_CONFLICT" })
    expect(await readFile(join(projectRoot, "a.txt"), "utf8")).toBe("a0\n")
    expect(await readFile(join(projectRoot, "b.txt"), "utf8")).toBe("external\n")
    expect((await readSessionWorkspaceApplyState(binding)).canUndo).toBe(false)

    const applied = await applySessionWorkspaceChanges(binding, {
      revision: current.revision,
      selections: [{ path: "a.txt" }],
    })
    await writeFile(join(projectRoot, "a.txt"), "external-after-apply\n")
    await expect(undoLastSessionWorkspaceApply(binding, { revision: current.revision })).rejects.toMatchObject({
      code: "WORKSPACE_UNDO_CONFLICT",
    })
    expect(await readFile(join(projectRoot, "a.txt"), "utf8")).toBe("external-after-apply\n")
    expect((await readSessionWorkspaceApplyState(binding)).lastApplyId).toBe(applied.operation.id)
  })

  test("rejects traversal, reserved paths, and symbolic-link components without touching outside files", async () => {
    const { root, projectRoot, binding } = await bindingFixture("paths", { "safe.txt": "old\n" })
    await writeFile(join(binding.workRoot, "safe.txt"), "new\n")
    let diff = await diffFor(binding)
    for (const path of ["../outside.txt", "/tmp/outside.txt", "..\\outside.txt", "C:\\outside.txt"]) {
      await expect(applySessionWorkspaceChanges(binding, {
        revision: diff.revision,
        selections: [{ path }],
      })).rejects.toMatchObject({ code: "WORKSPACE_PATH_INVALID" })
    }

    await writeFile(join(binding.workRoot, "pwd"), "not-allowed\n")
    diff = await diffFor(binding)
    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "pwd" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_PATH_RESERVED" })
    await rm(join(binding.workRoot, "pwd"))

    await mkdir(join(binding.workRoot, ".tools"))
    await writeFile(join(binding.workRoot, ".tools/generated"), "not-allowed\n")
    diff = await diffFor(binding)
    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: ".tools/generated" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_PATH_RESERVED" })
    await rm(join(binding.workRoot, ".tools"), { recursive: true })

    const outsideDirectory = join(root, "outside")
    await mkdir(outsideDirectory)
    const sentinel = join(outsideDirectory, "sentinel.txt")
    await writeFile(sentinel, "outside-safe\n")
    await mkdir(join(binding.workRoot, "linked"))
    await writeFile(join(binding.workRoot, "linked/new.txt"), "agent\n")
    await symlink(outsideDirectory, join(projectRoot, "linked"))
    diff = await diffFor(binding)
    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "linked/new.txt" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_PATH_SYMLINK" })
    expect(await readFile(sentinel, "utf8")).toBe("outside-safe\n")
    await expect(lstat(join(outsideDirectory, "new.txt"))).rejects.toThrow()

    await rm(join(binding.workRoot, "safe.txt"))
    await symlink(sentinel, join(binding.workRoot, "safe.txt"))
    diff = await diffFor(binding)
    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "safe.txt" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_UNSUPPORTED" })
    expect(await readFile(sentinel, "utf8")).toBe("outside-safe\n")
  })

  test("rejects file-to-directory transitions before changing project or session files", async () => {
    const { projectRoot, binding } = await bindingFixture("file-to-directory", { "entry": "project\n" })
    await rm(join(binding.workRoot, "entry"))
    await mkdir(join(binding.workRoot, "entry"))
    await writeFile(join(binding.workRoot, "entry/child.txt"), "session\n")
    const diff = await diffFor(binding)
    expect(diff.files.map((file) => file.path)).toEqual(["entry", "entry/child.txt"])

    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "entry/child.txt" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_UNSUPPORTED" })
    await expect(discardSessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "entry" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGE_UNSUPPORTED" })

    expect(await readFile(join(projectRoot, "entry"), "utf8")).toBe("project\n")
    expect(await readFile(join(binding.workRoot, "entry/child.txt"), "utf8")).toBe("session\n")
  })

  test("allows exact whole-file invalid UTF-8 changes but never materializes them as hunks", async () => {
    const { projectRoot, binding } = await bindingFixture("utf8", {
      "invalid.txt": new Uint8Array([0xc3, 0x28, 0x0a]),
    })
    const changed = new Uint8Array([0xc3, 0x29, 0x0a])
    await writeFile(join(binding.workRoot, "invalid.txt"), changed)
    const diff = await diffFor(binding)
    const hunk = diff.files[0]?.hunks[0]
    expect(hunk).toBeDefined()

    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "invalid.txt", hunkIds: [hunk!.id] }],
    })).rejects.toMatchObject({ code: "WORKSPACE_HUNKS_UNAVAILABLE" })
    await applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "invalid.txt" }],
    })
    expect(new Uint8Array(await readFile(join(projectRoot, "invalid.txt")))).toEqual(changed)
  })

  test("rejects a symlink planted at the journal location", async () => {
    const { root, binding } = await bindingFixture("journal-link", { "note.txt": "old\n" })
    await writeFile(join(binding.workRoot, "note.txt"), "new\n")
    const outside = join(root, "outside-journal")
    await mkdir(outside)
    await symlink(outside, join(binding.root, ".apply-journal"))
    const diff = await diffFor(binding)

    await expect(applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_JOURNAL_INVALID" })
    expect((await lstat(outside)).isDirectory()).toBe(true)
  })

  test("rolls back an interrupted pending journal transaction on the next operation", async () => {
    const { projectRoot, binding } = await bindingFixture("recovery", { "note.txt": "old\n" })
    await writeFile(join(binding.workRoot, "note.txt"), "new\n")
    const diff = await diffFor(binding)
    await applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt" }],
    })
    expect(await readFile(join(projectRoot, "note.txt"), "utf8")).toBe("new\n")

    const journalPath = join(binding.root, ".apply-journal/journal.json")
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as any
    const apply = journal.operations[0]
    await writeFile(journalPath, `${JSON.stringify({
      version: journal.version,
      operations: [],
      pending: {
        id: apply.id,
        action: "apply",
        scope: "project",
        changes: apply.changes,
      },
    })}\n`)

    const state = await readSessionWorkspaceApplyState(binding)
    expect(state).toEqual({ operations: [], canUndo: false })
    expect(await readFile(join(projectRoot, "note.txt"), "utf8")).toBe("old\n")
    const recovered = JSON.parse(await readFile(journalPath, "utf8")) as any
    expect(recovered.pending).toBeUndefined()
  })

  test("clears an interrupted pending deletion that had not changed the project", async () => {
    const { projectRoot, binding } = await bindingFixture("recovery-delete", { "note.txt": "old\n" })
    await rm(join(binding.workRoot, "note.txt"))
    const diff = await diffFor(binding)
    await applySessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt" }],
    })

    const journalPath = join(binding.root, ".apply-journal/journal.json")
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as any
    const apply = journal.operations[0]
    await writeFile(join(projectRoot, "note.txt"), "old\n")
    await writeFile(journalPath, `${JSON.stringify({
      version: journal.version,
      operations: [],
      pending: {
        id: apply.id,
        action: "apply",
        scope: "project",
        changes: apply.changes,
      },
    })}\n`)

    expect(await readSessionWorkspaceApplyState(binding)).toEqual({ operations: [], canUndo: false })
    expect(await readFile(join(projectRoot, "note.txt"), "utf8")).toBe("old\n")
    const recovered = JSON.parse(await readFile(journalPath, "utf8")) as any
    expect(recovered.pending).toBeUndefined()
  })

  test("rejects duplicate operation ids across non-apply journal entries", async () => {
    const { binding } = await bindingFixture("journal-ids", { "note.txt": "old\n" })
    await writeFile(join(binding.workRoot, "note.txt"), "first\n")
    let diff = await diffFor(binding)
    await discardSessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt" }],
    })
    await writeFile(join(binding.workRoot, "note.txt"), "second\n")
    diff = await diffFor(binding)
    await discardSessionWorkspaceChanges(binding, {
      revision: diff.revision,
      selections: [{ path: "note.txt" }],
    })

    const journalPath = join(binding.root, ".apply-journal/journal.json")
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as any
    journal.operations[1].id = journal.operations[0].id
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`)

    await expect(readSessionWorkspaceApplyState(binding)).rejects.toMatchObject({
      code: "WORKSPACE_JOURNAL_INVALID",
    })
  })
})

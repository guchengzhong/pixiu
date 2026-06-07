import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { PathGuard } from "../../src/sandbox/path"

describe("path guard", () => {
  test("allows paths inside workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-path-"))
    const guard = new PathGuard({ workspaceRoot: root, workspaceOnly: true })
    expect(guard.resolvePath("a.txt").outsideWorkspace).toBe(false)
  })

  test("rejects paths outside workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-path-"))
    const guard = new PathGuard({ workspaceRoot: root, workspaceOnly: true })
    expect(() => guard.resolvePath("../secret.txt")).toThrow("Path escapes workspace")
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { classifyShellCommand, findOutsideWorkspaceShellWrite } from "../../src/sandbox/shell"

describe("shell sandbox helpers", () => {
  test("classifies command risk", () => {
    expect(classifyShellCommand("ls -la")).toMatchObject({ risk: "low", category: "read" })
    expect(classifyShellCommand("curl https://example.test")).toMatchObject({ risk: "high", category: "network" })
    expect(classifyShellCommand("npm install left-pad")).toMatchObject({ risk: "high", category: "package" })
    expect(classifyShellCommand("git reset --hard")).toMatchObject({ risk: "medium", category: "git" })
    expect(classifyShellCommand("rm -rf build")).toMatchObject({ risk: "high", category: "delete" })
  })

  test("detects obvious outside-workspace shell writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-shell-helper-"))

    expect(findOutsideWorkspaceShellWrite("printf nope > ../outside.txt", root)).toBe("../outside.txt")
    expect(findOutsideWorkspaceShellWrite("printf ok > .minicode/tmp/a.txt", root)).toBeUndefined()
  })
})

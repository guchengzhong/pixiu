import { describe, expect, test } from "bun:test"
import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import type { MinicodeProcessResult } from "../harness/minicode-process"
import { expectExit, withMinicodeFixture } from "../harness/minicode-process"
import { runScenario, text, tool } from "../harness/scenario"

describe("harness hardening", () => {
  test("fake LLM exposes calls, inputs, pending, and wait", async () => {
    await withMinicodeFixture(async ({ llm, run }) => {
      await expect(llm.wait(1, { timeoutMs: 10 })).rejects.toThrow("Timed out waiting")

      llm.text("FINAL: observed")
      llm.text("FINAL: unused")
      const waitForFirstCall = llm.wait(1, { timeoutMs: 1_000 })

      const result = await run("observe request body", { json: true })

      await waitForFirstCall
      expectExit(result, 0)
      expect(llm.calls()).toBe(1)
      expect(llm.pending()).toBe(1)

      const inputs = llm.inputs()
      expect(inputs).toHaveLength(1)
      expect(JSON.stringify(inputs[0])).toContain("observe request body")

      inputs[0]!.model = "mutated"
      expect(llm.inputs()[0]!.model).toBe("openai-compatible/test-model")
    })
  })

  test("scenario evidence bundle includes session and workspace file contents", async () => {
    let evidenceDir: string | undefined
    try {
      await runScenario({
        name: "evidence captures contents",
        prompt: "写一个用于 evidence 的文件",
        replies: [tool("write", { path: "artifact.md", content: "artifact content for evidence" }), text("FINAL: done")],
        run: { yes: true },
        expect: {
          workspaceFiles: {
            "missing.md": "not present",
          },
        },
      })
      throw new Error("scenario should have failed")
    } catch (error) {
      evidenceDir = evidencePathFrom(error)
      const workspaceFiles = await readAllFiles(join(evidenceDir, "workspace"))
      const sessionFiles = await readAllFiles(join(evidenceDir, "sessions"))

      expect(workspaceFiles.some((file) => file.path.endsWith("artifact.md") && file.content.includes("artifact content for evidence"))).toBe(true)
      expect(sessionFiles.some((file) => file.path.endsWith(".jsonl") && file.content.includes("artifact.md"))).toBe(true)
      expect(await readFile(join(evidenceDir, "workspace-tree.txt"), "utf8")).toContain("artifact.md")
      expect(await readFile(join(evidenceDir, "sessions-tree.txt"), "utf8")).toContain(".jsonl")
    } finally {
      if (evidenceDir) await rm(evidenceDir, { recursive: true, force: true })
    }
  })

  test("spawn handles are closed by fixture teardown", async () => {
    let resultPromise: Promise<MinicodeProcessResult> | undefined

    await withMinicodeFixture(async ({ llm, spawn }) => {
      llm.hang()
      const handle = spawn(["run", "--json", "hang until teardown"], { timeoutMs: 30_000 })
      resultPromise = handle.result()
      await llm.wait(1, { timeoutMs: 1_000 })
    })

    const result = await withTimeout(resultPromise, 2_000)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
  })
})

function evidencePathFrom(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/Evidence:\s*(.+)\s*$/m)
  if (!match?.[1]) throw new Error(`missing evidence path in error: ${message}`)
  return match[1].trim()
}

async function readAllFiles(root: string) {
  const rows: Array<{ path: string; content: string }> = []
  await readAllFilesInner(root, rows)
  return rows
}

async function readAllFilesInner(root: string, rows: Array<{ path: string; content: string }>) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await readAllFilesInner(path, rows)
    } else if (entry.isFile()) {
      rows.push({ path, content: await readFile(path, "utf8") })
    }
  }
}

function withTimeout<T>(promise: Promise<T> | undefined, timeoutMs: number) {
  if (!promise) throw new Error("missing promise")
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
  ])
}

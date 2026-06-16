import { describe, expect, test } from "bun:test"

import { StaticPermissionManager } from "../../src/permission/evaluator"
import { PathGuard } from "../../src/sandbox/path"
import { createBuiltinTools } from "../../src/tools/builtin"
import { ToolRegistry } from "../../src/tools/registry"
import type { ToolContext } from "../../src/tools/types"

function registry() {
  return new ToolRegistry().registerMany(createBuiltinTools())
}

function context(): ToolContext {
  const cwd = process.cwd()
  return {
    cwd,
    workspaceRoot: cwd,
    permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
    pathGuard: new PathGuard({ workspaceRoot: cwd, workspaceOnly: true }),
    config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
  }
}

describe("todo builtins", () => {
  test("todowrite accepts a valid complete snapshot", async () => {
    const result = await registry().execute(
      "todowrite",
      {
        todos: [
          { id: "inspect", content: "Inspect workspace", status: "completed", priority: "high" },
          { id: "implement", content: "Implement change", status: "in_progress", priority: "medium" },
          { id: "verify", content: "Run checks", status: "pending", priority: "low" },
        ],
      },
      context(),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain("(high) Inspect workspace #inspect")
    expect(result.metadata?.todos).toEqual([
      { id: "inspect", content: "Inspect workspace", status: "completed", priority: "high" },
      { id: "implement", content: "Implement change", status: "in_progress", priority: "medium" },
      { id: "verify", content: "Run checks", status: "pending", priority: "low" },
    ])
  })

  test("todowrite generates stable ids for missing ids", async () => {
    const input = {
      todos: [
        { content: "Read files", status: "completed", priority: "high" },
        { content: "Read files", status: "pending", priority: "low" },
        { content: "Ship UI polish!", status: "pending", priority: "medium" },
      ],
    }

    const first = await registry().execute("todowrite", input, context())
    const second = await registry().execute("todowrite", input, context())

    expect(first.ok).toBe(true)
    expect(first.metadata?.todos).toEqual(second.metadata?.todos)
    expect(first.metadata?.todos).toMatchObject([
      { id: "todo_read_files" },
      { id: "todo_read_files_2" },
      { id: "todo_ship_ui_polish" },
    ])
  })

  test("todowrite preserves provided ids", async () => {
    const result = await registry().execute(
      "todowrite",
      {
        todos: [{ id: "custom-id-1", content: "Keep id", status: "pending", priority: "medium" }],
      },
      context(),
    )

    expect(result.ok).toBe(true)
    expect(result.metadata?.todos).toMatchObject([{ id: "custom-id-1", content: "Keep id" }])
  })

  test("todowrite rejects empty content", async () => {
    const result = await registry().execute(
      "todowrite",
      {
        todos: [{ content: "   ", status: "pending", priority: "medium" }],
      },
      context(),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toContain("content must be a non-empty string")
  })

  test("todowrite rejects multiple in_progress todos", async () => {
    const result = await registry().execute(
      "todowrite",
      {
        todos: [
          { content: "Do first", status: "in_progress", priority: "high" },
          { content: "Do second", status: "in_progress", priority: "medium" },
        ],
      },
      context(),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toContain("at most one in_progress")
  })

  test("legacy todo remains compatible and exposes pending todo metadata", async () => {
    const result = await registry().execute("todo", { items: ["inspect workspace", "write summary", "   "] }, context())

    expect(result.ok).toBe(true)
    expect(result.content).toBe("1. inspect workspace\n2. write summary")
    expect(result.data).toEqual(["inspect workspace", "write summary"])
    expect(result.metadata?.todos).toEqual([
      { id: "todo_inspect_workspace", content: "inspect workspace", status: "pending", priority: "medium" },
      { id: "todo_write_summary", content: "write summary", status: "pending", priority: "medium" },
    ])
  })
})

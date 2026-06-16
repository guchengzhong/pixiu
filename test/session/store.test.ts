import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemorySessionStore } from "../../src/session/memory"
import { JsonlSessionStore } from "../../src/session/jsonl"

describe("session stores", () => {
  test("memory store appends and reads messages", async () => {
    const store = new MemorySessionStore()
    const session = await store.create({ cwd: process.cwd(), title: "hello" })
    await store.appendMessage({ sessionId: session.id, role: "user", parts: [{ type: "text", text: "hi" }] })

    expect((await store.listSessions()).length).toBe(1)
    expect((await store.readMessages(session.id))[0]?.parts[0]).toEqual({ type: "text", text: "hi" })
  })

  test("jsonl store resumes after process boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-session-"))
    const first = new JsonlSessionStore(root)
    const session = await first.create({ cwd: process.cwd(), title: "resume" })
    await first.appendMessage({ sessionId: session.id, role: "assistant", parts: [{ type: "text", text: "ok" }] })

    const second = new JsonlSessionStore(root)
    expect((await second.readMessages(session.id))[0]?.parts[0]).toEqual({ type: "text", text: "ok" })
  })

  test("jsonl store persists todo state across reloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-session-todos-"))
    const first = new JsonlSessionStore(root)
    const session = await first.create({ cwd: process.cwd(), title: "todos" })
    await first.updateTodos(session.id, [
      { id: "one", content: "One", status: "completed", priority: "high" },
      { id: "two", content: "Two", status: "in_progress", priority: "medium" },
    ])

    const second = new JsonlSessionStore(root)
    expect(await second.getTodos(session.id)).toEqual([
      { id: "one", content: "One", status: "completed", priority: "high" },
      { id: "two", content: "Two", status: "in_progress", priority: "medium" },
    ])
    expect(await second.getTodoState(session.id)).toMatchObject({ currentTodoId: "two" })
  })

  test("jsonl store returns empty todos for existing sessions without todo state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-session-no-todos-"))
    const store = new JsonlSessionStore(root)
    const session = await store.create({ cwd: process.cwd(), title: "old session" })

    expect(await store.getTodos(session.id)).toEqual([])
    expect(await store.getTodoState(session.id)).toEqual({ todos: [] })
  })

  test("jsonl updateTodos appends state without rewriting messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-session-todo-append-"))
    const store = new JsonlSessionStore(root)
    const session = await store.create({ cwd: process.cwd(), title: "append" })
    await store.appendMessage({ sessionId: session.id, role: "user", parts: [{ type: "text", text: "hi" }] })
    const before = await readFile(join(root, `${session.id}.jsonl`), "utf8")

    await store.updateTodos(session.id, [{ id: "todo", content: "Track work", status: "pending", priority: "medium" }])
    const after = await readFile(join(root, `${session.id}.jsonl`), "utf8")

    expect((before.match(/"type":"message"/g) ?? []).length).toBe(1)
    expect((after.match(/"type":"message"/g) ?? []).length).toBe(1)
    expect((after.match(/"type":"todo_state"/g) ?? []).length).toBe(1)
    expect(await store.readMessages(session.id)).toHaveLength(1)
  })

  test("jsonl store reports corrupt lines with file and line", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-session-bad-"))
    await writeFile(join(root, "bad.jsonl"), "{\"type\":\"session\"\n", "utf8")
    const store = new JsonlSessionStore(root)

    await expect(store.getSession("bad")).rejects.toThrow("bad.jsonl:1")
  })
})

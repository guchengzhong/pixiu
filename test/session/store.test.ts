import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
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
    const root = await mkdtemp(join(tmpdir(), "minicode-session-"))
    const first = new JsonlSessionStore(root)
    const session = await first.create({ cwd: process.cwd(), title: "resume" })
    await first.appendMessage({ sessionId: session.id, role: "assistant", parts: [{ type: "text", text: "ok" }] })

    const second = new JsonlSessionStore(root)
    expect((await second.readMessages(session.id))[0]?.parts[0]).toEqual({ type: "text", text: "ok" })
  })

  test("jsonl store reports corrupt lines with file and line", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-session-bad-"))
    await writeFile(join(root, "bad.jsonl"), "{\"type\":\"session\"\n", "utf8")
    const store = new JsonlSessionStore(root)

    await expect(store.getSession("bad")).rejects.toThrow("bad.jsonl:1")
  })
})

import { describe, expect, test } from "bun:test"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

import type { AgentEvent } from "../../src/agent/events"
import { expectExit, parseJsonEvents, withMinicodeFixture } from "../harness/minicode-process"

describe("minicode run subprocess", () => {
  test("prints a successful final response", async () => {
    await withMinicodeFixture(async ({ llm, run }) => {
      llm.text("FINAL: hello from fake llm")

      const result = await run("say hi")

      expectExit(result, 0)
      expect(result.stdout).toContain("hello from fake llm")
      expect(result.stdout).not.toContain("FINAL:")
      expect(result.stderr).toBe("")
    })
  })

  test("does not leak reasoning or completion protocol markers in text output", async () => {
    await withMinicodeFixture(async ({ llm, run }) => {
      llm.text("FINAL: visible answer", { reasoning: "hidden chain of thought" })

      const result = await run("say hi")

      expectExit(result, 0)
      expect(result.stdout).toContain("visible answer")
      expect(result.stdout).not.toContain("hidden chain of thought")
      expect(result.stdout).not.toContain("FINAL:")
    })
  })

  test("keeps markdown answers readable in text output", async () => {
    await withMinicodeFixture(async ({ llm, run }) => {
      llm.text("FINAL: # Summary\n\n- first\n- second\n\n```ts\nconst ok = true\n```")

      const result = await run("markdown please")

      expectExit(result, 0)
      expect(result.stdout).toContain("Summary")
      expect(result.stdout).toContain("- first")
      expect(result.stdout).toContain("```ts")
      expect(result.stdout).toContain("const ok = true")
    })
  })

  test("prints friendly tool traces in non-json mode", async () => {
    await withMinicodeFixture(async ({ llm, run }) => {
      llm.tool("write", { path: "trace.md", content: "trace ok" })
      llm.text("FINAL: wrote trace.md")

      const result = await run("write a trace file", { yes: true })

      expectExit(result, 0)
      expect(result.stdout).toContain("tool write trace.md")
      expect(result.stdout).toContain("  ok")
      expect(result.stdout).toContain("wrote trace.md")
      expect(result.stdout).not.toContain('{"type":"tool_call"')
      expect(result.stderr).toBe("")
    })
  })

  test("emits parseable JSONL events", async () => {
    await withMinicodeFixture(async ({ llm, run }) => {
      llm.text("FINAL: json ok")

      const result = await run("say hi as json", { json: true })

      expectExit(result, 0)
      const events = parseJsonEvents(result.stdout)
      expect(events.map((event) => event.type)).toEqual(["session_created", "llm_text_delta", "message", "finish"])
      expect(events.find((event) => event.type === "message")).toMatchObject({ content: "json ok" })
      expect(result.stderr).toBe("")
    })
  })

  test("supports CodeBuddy-style stream-json output", async () => {
    await withMinicodeFixture(async ({ llm, exec }) => {
      llm.tool("write", { path: "hello.txt", content: "hello stream" })
      llm.text("FINAL: stream ok")

      const result = await exec(["run", "--output-format", "stream-json", "--yes", "write and summarize"])

      expectExit(result, 0)
      const events = parseJsonEvents<Record<string, any>>(result.stdout)
      expect(events[0]).toMatchObject({ type: "system", subtype: "init", permissionMode: "bypassPermissions" })
      expect(events.some((event) => event.type === "assistant" && event.message?.content?.[0]?.type === "tool_use")).toBe(true)
      expect(events.some((event) => event.type === "user" && event.message?.content?.[0]?.type === "tool_result")).toBe(true)
      expect(events.filter((event) => event.type === "assistant" && event.message?.content?.[0]?.type === "text")).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", result: "stream ok" })
    })
  })

  test("permission-mode bypassPermissions is accepted in stream-json output", async () => {
    await withMinicodeFixture(async ({ llm, exec }) => {
      llm.tool("write", { path: "mode.txt", content: "mode ok" })
      llm.text("FINAL: mode ok")

      const result = await exec(["run", "--output-format", "stream-json", "--permission-mode", "bypassPermissions", "write"])

      expectExit(result, 0)
      const events = parseJsonEvents<Record<string, any>>(result.stdout)
      expect(events[0]).toMatchObject({ type: "system", subtype: "init", permissionMode: "bypassPermissions" })
      expect(events.some((event) => event.type === "user" && event.message?.content?.[0]?.is_error === false)).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", result: "mode ok" })
    })
  })

  test("permission-mode acceptEdits allows writes without --yes", async () => {
    await withMinicodeFixture(async ({ llm, projectDir, exec }) => {
      llm.tool("write", { path: "accepted.md", content: "accepted" })
      llm.text("FINAL: accepted")

      const result = await exec(["run", "--json", "--permission-mode", "acceptEdits", "write accepted.md"])

      expectExit(result, 0)
      const events = parseJsonEvents(result.stdout)
      const sessionId = sessionIdFrom(events)
      expect(await readFile(join(projectDir, "workspace", sessionId, "accepted.md"), "utf8")).toBe("accepted")
      expect(events.some((event) => event.type === "tool_result" && event.name === "write" && event.ok)).toBe(true)
    })
  })

  test("permission-mode plan denies write tools", async () => {
    await withMinicodeFixture(async ({ llm, projectDir, exec }) => {
      llm.tool("write", { path: "plan.md", content: "should not write" })
      llm.text("FINAL: planned only")

      const result = await exec(["run", "--json", "--permission-mode", "plan", "plan a write"])

      expectExit(result, 3)
      const events = parseJsonEvents(result.stdout)
      const sessionId = sessionIdFrom(events)
      expect(await exists(join(projectDir, "workspace", sessionId, "plan.md"))).toBe(false)
      expect(
        events.some(
          (event) =>
            event.type === "tool_result" &&
            event.name === "write" &&
            !event.ok &&
            event.content.includes("permission mode plan"),
        ),
      ).toBe(true)
    })
  })

  test("-p aliases non-interactive text output", async () => {
    await withMinicodeFixture(async ({ llm, exec }) => {
      llm.text("FINAL: print ok")

      const result = await exec(["-p", "say hi"])

      expectExit(result, 0)
      expect(result.stdout).toContain("print ok")
      expect(result.stdout).not.toContain("FINAL:")
    })
  })

  test("output-format json returns an event array and result summary", async () => {
    await withMinicodeFixture(async ({ llm, exec }) => {
      llm.text("FINAL: json array ok")

      const result = await exec(["run", "--output-format", "json", "say hi"])

      expectExit(result, 0)
      const events = JSON.parse(result.stdout)
      expect(Array.isArray(events)).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", result: "json array ok" })
    })
  })

  test("writes files inside the session workspace", async () => {
    await withMinicodeFixture(async ({ llm, projectDir, run }) => {
      llm.tool("write", { path: "hello.md", content: "workspace ok" }, { splitArgs: true })
      llm.text("FINAL: wrote hello.md")

      const result = await run("write hello.md", { json: true, yes: true })

      expectExit(result, 0)
      const events = parseJsonEvents(result.stdout)
      const sessionId = sessionIdFrom(events)
      const workspaceFile = join(projectDir, "workspace", sessionId, "hello.md")
      const projectFile = join(projectDir, "hello.md")

      expect(await readFile(workspaceFile, "utf8")).toBe("workspace ok")
      expect(await exists(projectFile)).toBe(false)
      expect(events.some((event) => event.type === "tool_result" && event.name === "write" && event.ok)).toBe(true)
    })
  })

  test("resumes with the prior session workspace", async () => {
    await withMinicodeFixture(async ({ llm, run }) => {
      llm.tool("write", { path: "hello.md", content: "workspace ok" })
      llm.text("FINAL: wrote hello.md")
      const first = await run("write hello.md", { json: true, yes: true })
      expectExit(first, 0)
      const sessionId = sessionIdFrom(parseJsonEvents(first.stdout))

      llm.tool("read", { path: "hello.md" })
      llm.text("FINAL: read previous file")
      const second = await run("read hello.md again", { json: true, yes: true, sessionId })

      expectExit(second, 0)
      const events = parseJsonEvents(second.stdout)
      expect(sessionIdFrom(events)).toBe(sessionId)
      expect(
        events.some(
          (event) => event.type === "tool_result" && event.name === "read" && event.ok && event.content.includes("workspace ok"),
        ),
      ).toBe(true)
    })
  })

  test("--continue resumes the most recent session", async () => {
    await withMinicodeFixture(async ({ llm, exec, run }) => {
      llm.tool("write", { path: "latest.md", content: "latest workspace" })
      llm.text("FINAL: wrote latest")
      const first = await run("write latest.md", { json: true, yes: true })
      expectExit(first, 0)
      const sessionId = sessionIdFrom(parseJsonEvents(first.stdout))

      llm.tool("read", { path: "latest.md" })
      llm.text("FINAL: continued latest")
      const second = await exec(["run", "--json", "--yes", "-c", "continue latest"])

      expectExit(second, 0)
      const secondEvents = parseJsonEvents(second.stdout)
      expect(sessionIdFrom(secondEvents)).toBe(sessionId)
      expect(secondEvents.some((event) => event.type === "tool_result" && event.name === "read" && event.ok)).toBe(true)
    })
  })

  test("session resume prints the latest session id", async () => {
    await withMinicodeFixture(async ({ llm, exec, run }) => {
      llm.text("FINAL: session created")
      const first = await run("create a session", { json: true })
      expectExit(first, 0)
      const sessionId = sessionIdFrom(parseJsonEvents(first.stdout))

      const resume = await exec(["session", "resume"])
      expectExit(resume, 0)
      expect(resume.stdout.trim()).toBe(sessionId)
    })
  })

  test("surfaces provider errors without hanging", async () => {
    await withMinicodeFixture(async ({ llm, run }) => {
      llm.error(401, { error: "bad key" })

      const result = await run("trigger provider error", { json: true, timeoutMs: 3_000 })

      expectExit(result, 2)
      const events = parseJsonEvents(result.stdout)
      expect(events.some((event) => event.type === "error" && event.message.includes("LLM request failed (401)"))).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
    })
  })

  test("max steps exits with a script-visible status", async () => {
    await withMinicodeFixture(async ({ llm, exec }) => {
      for (let index = 0; index < 10; index += 1) llm.tool("todo", { items: [`step ${index}`] })

      const result = await exec(["run", "--output-format", "json", "loop until max steps"])

      expectExit(result, 4)
      const events = JSON.parse(result.stdout)
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "error", finish_reason: "max_steps" })
    })
  })
})

function sessionIdFrom(events: AgentEvent[]) {
  const event = events.find((item) => item.type === "session_created")
  if (!event) throw new Error("missing session_created event")
  return event.sessionId
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

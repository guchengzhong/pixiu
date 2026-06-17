import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { AgentRunner } from "../../src/agent/runner"
import { MemorySessionStore } from "../../src/session/memory"
import { ToolRegistry } from "../../src/tools/registry"
import { StaticPermissionManager } from "../../src/permission/evaluator"
import { PathGuard } from "../../src/sandbox/path"
import { ScriptedLLMClient } from "../fixtures/scripted-llm"
import { createBuiltinTools } from "../../src/tools/builtin"
import type { AgentEvent } from "../../src/agent/events"
import type { JsonObject } from "../../src/shared/json"

describe("agent runner", () => {
  test("closes a scripted tool-call loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-"))
    const llm = new ScriptedLLMClient([
      [{ type: "tool_call", call: { id: "call_1", name: "echo", input: { text: "ping" } } }, { type: "finish", reason: "tool_calls" }],
      [{ type: "text_start" }, { type: "text_delta", text: "FINAL: pong" }, { type: "text_end", text: "FINAL: pong" }, { type: "finish", reason: "stop" }],
    ])
    const tools = new ToolRegistry().register({
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async execute(input) {
        return { ok: true, content: String(input.text), data: input }
      },
    })
    const runner = new AgentRunner({
      llm,
      tools,
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "go" })) events.push(event)

    expect(events.find((event) => event.type === "context_usage")).toMatchObject({
      type: "context_usage",
      source: "estimated",
    })
    expect(events.some((event) => event.type === "tool_result" && event.ok)).toBe(true)
    expect(events.some((event) => event.type === "message" && event.content === "pong")).toBe(true)
  })

  test("emits provider usage when the model stream includes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-provider-usage-"))
    const runner = new AgentRunner({
      llm: new ScriptedLLMClient([
        [
          { type: "usage", usage: { inputTokens: 321, outputTokens: 12, totalTokens: 333 } },
          { type: "text_start" },
          { type: "text_delta", text: "FINAL: usage ok" },
          { type: "text_end", text: "FINAL: usage ok" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      tools: new ToolRegistry(),
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "go" })) events.push(event)

    expect(events).toContainEqual({ type: "context_usage", inputTokens: 321, outputTokens: 12, source: "provider" })
    expect(events.some((event) => event.type === "message" && event.content === "usage ok")).toBe(true)
  })

  test("emits assistant progress before tool calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-progress-"))
    const llm = new ScriptedLLMClient([
      [
        { type: "text_start" },
        { type: "text_delta", text: "我先查看一下文件。" },
        { type: "tool_call", call: { id: "call_1", name: "echo", input: { text: "ping" } } },
        { type: "finish", reason: "tool_calls" },
      ],
      [{ type: "text_start" }, { type: "text_delta", text: "FINAL: pong" }, { type: "text_end", text: "FINAL: pong" }, { type: "finish", reason: "stop" }],
    ])
    const tools = new ToolRegistry().register({
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async execute(input) {
        return { ok: true, content: String(input.text), data: input }
      },
    })
    const runner = new AgentRunner({
      llm,
      tools,
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "go" })) events.push(event)

    expect(events.map((event) => event.type).slice(0, 5)).toEqual([
      "session_created",
      "context_usage",
      "assistant_progress_delta",
      "tool_call",
      "tool_result",
    ])
    expect(events.find((event) => event.type === "assistant_progress_delta")).toMatchObject({ text: "我先查看一下文件。" })
  })

  test("stops on LLM error events", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-error-"))
    const runner = new AgentRunner({
      llm: new ScriptedLLMClient([[{ type: "error", error: "LLM request failed (401): invalid key", code: "LLM_REQUEST_FAILED" }]]),
      tools: new ToolRegistry(),
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "go" })) events.push(event)

    expect(events.some((event) => event.type === "error" && event.message.includes("401"))).toBe(true)
    expect(events.some((event) => event.type === "finish" && event.reason === "error")).toBe(true)
    expect(events.some((event) => event.type === "message")).toBe(false)
  })

  test("treats AbortError from the provider as a cancelled run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-abort-"))
    const controller = new AbortController()
    const runner = new AgentRunner({
      llm: {
        async *stream() {
          controller.abort()
          throw new DOMException("The operation was aborted.", "AbortError")
        },
      },
      tools: new ToolRegistry(),
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "go", signal: controller.signal })) events.push(event)

    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "cancelled" })
  })

  test("continues when the assistant returns a non-final draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-continue-"))
    const runner = new AgentRunner({
      llm: new ScriptedLLMClient([
        [{ type: "text_start" }, { type: "text_delta", text: "我来查询一下。" }, { type: "text_end", text: "我来查询一下。" }, { type: "finish", reason: "stop" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: 已完成" }, { type: "text_end", text: "FINAL: 已完成" }, { type: "finish", reason: "stop" }],
      ]),
      tools: new ToolRegistry(),
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "武汉洪山区明天天气如何？" })) events.push(event)

    expect(events.some((event) => event.type === "message" && event.content === "已完成")).toBe(true)
    expect(events.some((event) => event.type === "message" && event.content.includes("我来查询"))).toBe(false)
  })

  test("accepts markdown-bold FINAL marker without leaking it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-bold-final-"))
    const runner = new AgentRunner({
      llm: new ScriptedLLMClient([
        [
          { type: "text_start" },
          { type: "text_delta", text: "**FINAL:** bold marker stripped" },
          { type: "text_end", text: "**FINAL:** bold marker stripped" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      tools: new ToolRegistry(),
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "go" })) events.push(event)

    expect(events.some((event) => event.type === "message" && event.content === "bold marker stripped")).toBe(true)
    expect(events.some((event) => event.type === "message" && event.content.includes("FINAL"))).toBe(false)
  })

  test("falls back after one non-final continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-draft-fallback-"))
    const runner = new AgentRunner({
      llm: new ScriptedLLMClient([
        [{ type: "text_start" }, { type: "text_delta", text: "我先看看。" }, { type: "text_end", text: "我先看看。" }, { type: "finish", reason: "stop" }],
        [{ type: "text_start" }, { type: "text_delta", text: "这里是没有标记的答案。" }, { type: "text_end", text: "这里是没有标记的答案。" }, { type: "finish", reason: "stop" }],
      ]),
      tools: new ToolRegistry(),
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "go" })) events.push(event)

    expect(events.some((event) => event.type === "message" && event.content === "这里是没有标记的答案。")).toBe(true)
    expect(events.some((event) => event.type === "finish" && event.reason === "max_steps")).toBe(false)
  })

  test("strips a final marker appended after continuation prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-late-final-"))
    const runner = new AgentRunner({
      llm: new ScriptedLLMClient([
        [{ type: "text_start" }, { type: "text_delta", text: "先确认一下。" }, { type: "text_end", text: "先确认一下。" }, { type: "finish", reason: "stop" }],
        [
          { type: "text_start" },
          { type: "text_delta", text: "I already replied.\n\nFINAL: ok" },
          { type: "text_end", text: "I already replied.\n\nFINAL: ok" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      tools: new ToolRegistry(),
      sessions: new MemorySessionStore(),
      model: "scripted",
      systemPrompt: "test",
      maxSteps: 4,
      toolContext: {
        cwd: root,
        workspaceRoot: root,
        permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
        pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
        config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
      },
    })

    const events = []
    for await (const event of runner.run({ message: "go" })) events.push(event)

    expect(events.some((event) => event.type === "message" && event.content === "ok")).toBe(true)
    expect(events.some((event) => event.type === "message" && event.content.includes("FINAL"))).toBe(false)
  })

  test("promotes successful todowrite metadata to todo_updated after tool_result", async () => {
    const { events } = await runScriptedTool("todowrite", {
      todos: [
        { id: "inspect", content: "Inspect workspace", status: "completed", priority: "high" },
        { id: "implement", content: "Implement change", status: "in_progress", priority: "medium" },
      ],
    })

    expect(eventTypesAround(events, "tool_call", "todo_updated")).toEqual(["tool_call", "tool_result", "todo_updated"])
    expect(events.find((event) => event.type === "todo_updated")).toMatchObject({
      type: "todo_updated",
      currentTodoId: "implement",
      todos: [
        { id: "inspect", content: "Inspect workspace", status: "completed", priority: "high" },
        { id: "implement", content: "Implement change", status: "in_progress", priority: "medium" },
      ],
    })
  })

  test("todo_updated omits currentTodoId when no todo is in progress", async () => {
    const { events } = await runScriptedTool("todowrite", {
      todos: [
        { id: "done", content: "Already done", status: "completed", priority: "low" },
        { id: "next", content: "Next up", status: "pending", priority: "medium" },
      ],
    })

    const event = events.find((item) => item.type === "todo_updated")
    expect(event).toMatchObject({ type: "todo_updated", todos: expect.any(Array) })
    expect(event && "currentTodoId" in event).toBe(false)
  })

  test("ordinary tool calls do not emit todo_updated and still emit tool events", async () => {
    const { events } = await runScriptedTool("echo", { text: "ping" }, echoTools())

    expect(events.some((event) => event.type === "tool_call" && event.name === "echo")).toBe(true)
    expect(events.some((event) => event.type === "tool_result" && event.name === "echo" && event.ok)).toBe(true)
    expect(events.some((event) => event.type === "todo_updated")).toBe(false)
    expect(events.some((event) => event.type === "message" && event.content === "done")).toBe(true)
  })

  test("strips Pixiu-only _activity before tool execution and persisted tool messages", async () => {
    const { events, sessions } = await runScriptedTool("echo", {
      text: "ping",
      _activity: {
        kind: "tool",
        title: "Pinging echo tool",
      },
    }, echoTools())
    const sessionId = events.find((event) => event.type === "session_created")?.sessionId
    const result = events.find((event) => event.type === "tool_result" && event.name === "echo")
    const toolCall = events.find((event) => event.type === "tool_call" && event.name === "echo")
    const messages = await sessions.readMessages(sessionId!)
    const storedCall = messages.flatMap((message) => message.parts).find((part) => part.type === "tool_call")

    expect(toolCall).toMatchObject({
      type: "tool_call",
      input: expect.objectContaining({ _activity: expect.any(Object) }),
    })
    expect(result).toMatchObject({ type: "tool_result", content: "ping" })
    expect(storedCall).toMatchObject({ type: "tool_call", input: { text: "ping" } })
  })

  test("legacy todo metadata is also promoted to todo_updated", async () => {
    const { events } = await runScriptedTool("todo", { items: ["inspect workspace", "write summary"] })

    expect(eventTypesAround(events, "tool_call", "todo_updated")).toEqual(["tool_call", "tool_result", "todo_updated"])
    expect(events.find((event) => event.type === "todo_updated")).toMatchObject({
      type: "todo_updated",
      todos: [
        { id: "todo_inspect_workspace", content: "inspect workspace", status: "pending", priority: "medium" },
        { id: "todo_write_summary", content: "write summary", status: "pending", priority: "medium" },
      ],
    })
  })

  test("runner persists todowrite todos to the session store", async () => {
    const { events, sessions } = await runScriptedTool("todowrite", {
      todos: [{ id: "persist", content: "Persist todos", status: "in_progress", priority: "high" }],
    })
    const sessionId = events.find((event) => event.type === "session_created")?.sessionId

    expect(sessionId).toBeString()
    expect(await sessions.getTodos(sessionId!)).toEqual([
      { id: "persist", content: "Persist todos", status: "in_progress", priority: "high" },
    ])
    expect(await sessions.getTodoState(sessionId!)).toMatchObject({ currentTodoId: "persist" })
  })

  test("failed todowrite does not persist todos", async () => {
    const { events, sessions } = await runScriptedTool("todowrite", {
      todos: [
        { content: "First", status: "in_progress", priority: "high" },
        { content: "Second", status: "in_progress", priority: "medium" },
      ],
    })
    const sessionId = events.find((event) => event.type === "session_created")?.sessionId

    expect(events.some((event) => event.type === "tool_result" && event.name === "todowrite" && !event.ok)).toBe(true)
    expect(events.some((event) => event.type === "todo_updated")).toBe(false)
    expect(await sessions.getTodos(sessionId!)).toEqual([])
  })
})

async function runScriptedTool(name: string, input: JsonObject, tools = new ToolRegistry().registerMany(createBuiltinTools())) {
  const root = await mkdtemp(join(tmpdir(), `pixiu-agent-${name}-`))
  const sessions = new MemorySessionStore()
  const runner = new AgentRunner({
    llm: new ScriptedLLMClient([
      [{ type: "tool_call", call: { id: "call_1", name, input } }, { type: "finish", reason: "tool_calls" }],
      [{ type: "text_start" }, { type: "text_delta", text: "FINAL: done" }, { type: "text_end", text: "FINAL: done" }, { type: "finish", reason: "stop" }],
    ]),
    tools,
    sessions,
    model: "scripted",
    systemPrompt: "test",
    maxSteps: 4,
    toolContext: {
      cwd: root,
      workspaceRoot: root,
      permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
      pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
      config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
    },
  })

  const events: AgentEvent[] = []
  for await (const event of runner.run({ message: "go" })) events.push(event)
  return { events, sessions }
}

function echoTools() {
  return new ToolRegistry().register({
    name: "echo",
    description: "echo",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(input) {
      return { ok: true, content: String(input.text), data: input }
    },
  })
}

function eventTypesAround(events: AgentEvent[], start: AgentEvent["type"], end: AgentEvent["type"]) {
  const startIndex = events.findIndex((event) => event.type === start)
  const endIndex = events.findIndex((event) => event.type === end)
  return events.slice(startIndex, endIndex + 1).map((event) => event.type)
}

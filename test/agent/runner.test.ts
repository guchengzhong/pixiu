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

  test("continues once after an empty response without tool calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-agent-empty-continuation-"))
    const runner = new AgentRunner({
      llm: new ScriptedLLMClient([
        [],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: recovered" }, { type: "text_end", text: "FINAL: recovered" }, { type: "finish", reason: "stop" }],
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

    expect(events.some((event) => event.type === "message" && event.content === "recovered")).toBe(true)
    expect(events.some((event) => event.type === "error" && event.message.includes("empty response"))).toBe(false)
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

  test("blocks workaround shell calls after Agent Reach skill finds missing CLI", async () => {
    const executedShellCommands: string[] = []
    const tools = agentReachRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "agent-reach doctor --json") {
        return {
          ok: false,
          content: "/bin/sh: 1: agent-reach: not found",
          metadata: { command, exitCode: 127 },
        }
      }
      return { ok: true, content: "unexpected", metadata: { command, exitCode: 0 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor", name: "shell", input: { command: "agent-reach doctor --json" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_scrape", name: "shell", input: { command: "python scrape_xhs.py" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: blocked" }, { type: "text_end", text: "FINAL: blocked" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    const blocked = events.find((event) => event.type === "tool_result" && event.id === "call_scrape")
    expect(executedShellCommands).toEqual(["agent-reach doctor --json"])
    expect(blocked).toMatchObject({
      type: "tool_result",
      ok: false,
      content: expect.stringContaining("Agent Reach is missing"),
      metadata: {
        skillRouteBlocked: true,
        blocker: { kind: "missing_managed_tool", skill: "agent-reach", tool: "agent-reach" },
      },
    })
  })

  test("allows managed Agent Reach installer and clears missing-tool blocker", async () => {
    const executedShellCommands: string[] = []
    let doctorAttempts = 0
    const tools = agentReachRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "agent-reach doctor --json") {
        doctorAttempts += 1
        if (doctorAttempts === 1) {
          return {
            ok: false,
            content: "/bin/sh: 1: agent-reach: not found",
            metadata: { command, exitCode: 127 },
          }
        }
        return { ok: true, content: "{\"ok\":true}", metadata: { command, exitCode: 0 } }
      }
      if (command === "pixiu tools install agent-reach --yes") {
        return { ok: true, content: "installed agent-reach", metadata: { command, exitCode: 0 } }
      }
      return { ok: false, content: `unexpected command: ${command}`, metadata: { command, exitCode: 1 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor_1", name: "shell", input: { command: "agent-reach doctor --json" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_install", name: "shell", input: { command: "pixiu tools install agent-reach --yes" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor_2", name: "shell", input: { command: "agent-reach doctor --json" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: available" }, { type: "text_end", text: "FINAL: available" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    expect(executedShellCommands).toEqual([
      "agent-reach doctor --json",
      "pixiu tools install agent-reach --yes",
      "agent-reach doctor --json",
    ])
    expect(events.find((event) => event.type === "tool_result" && event.id === "call_install")).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "installed agent-reach",
    })
    expect(events.find((event) => event.type === "tool_result" && event.id === "call_doctor_2")).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "{\"ok\":true}",
    })
  })

  test("blocks fallback shell calls after Browser Use skill finds missing CLI", async () => {
    const executedShellCommands: string[] = []
    const tools = skillRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "browser-use doctor") {
        return {
          ok: false,
          content: "/bin/sh: 1: browser-use: not found",
          metadata: { command, exitCode: 127 },
        }
      }
      return { ok: true, content: "unexpected", metadata: { command, exitCode: 0 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "browser-use" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor", name: "shell", input: { command: "browser-use doctor" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_scrape", name: "shell", input: { command: "python scrape_zhihu.py" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: blocked" }, { type: "text_end", text: "FINAL: blocked" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    const blocked = events.find((event) => event.type === "tool_result" && event.id === "call_scrape")
    expect(executedShellCommands).toEqual(["browser-use doctor"])
    expect(blocked).toMatchObject({
      type: "tool_result",
      ok: false,
      content: expect.stringContaining("browser-use is missing"),
      metadata: {
        skillRouteBlocked: true,
        blocker: { kind: "missing_managed_tool", skill: "browser-use", tool: "browser-use" },
        activity: {
          details: {
            allowedNext: ["request_user_action", "pixiu tools install browser-use --yes"],
          },
        },
      },
    })
  })

  test("allows managed Browser Use installer and clears missing-tool blocker", async () => {
    const executedShellCommands: string[] = []
    let doctorAttempts = 0
    const tools = skillRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "browser-use doctor") {
        doctorAttempts += 1
        if (doctorAttempts === 1) {
          return {
            ok: false,
            content: "/bin/sh: 1: browser-use: not found",
            metadata: { command, exitCode: 127 },
          }
        }
        return { ok: true, content: "browser-use ok", metadata: { command, exitCode: 0 } }
      }
      if (command === "pixiu tools install browser-use --yes") {
        return { ok: true, content: "installed browser-use", metadata: { command, exitCode: 0 } }
      }
      return { ok: false, content: `unexpected command: ${command}`, metadata: { command, exitCode: 1 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "browser-use" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor_1", name: "shell", input: { command: "browser-use doctor" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_install", name: "shell", input: { command: "pixiu tools install browser-use --yes" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor_2", name: "shell", input: { command: "browser-use doctor" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: available" }, { type: "text_end", text: "FINAL: available" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    expect(executedShellCommands).toEqual([
      "browser-use doctor",
      "pixiu tools install browser-use --yes",
      "browser-use doctor",
    ])
    expect(events.find((event) => event.type === "tool_result" && event.id === "call_install")).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "installed browser-use",
    })
    expect(events.find((event) => event.type === "tool_result" && event.id === "call_doctor_2")).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "browser-use ok",
    })
  })

  test("auto-installs Agent Reach when managed tool policy allows it", async () => {
    const executedShellCommands: string[] = []
    const installCalls: string[] = []
    const tools = agentReachRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "agent-reach doctor --json") {
        return {
          ok: false,
          content: "/bin/sh: 1: agent-reach: not found",
          metadata: { command, exitCode: 127 },
        }
      }
      return { ok: false, content: `unexpected command: ${command}`, metadata: { command, exitCode: 1 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor", name: "shell", input: { command: "agent-reach doctor --json" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: installed" }, { type: "text_end", text: "FINAL: installed" }, { type: "finish", reason: "stop" }],
      ],
      tools,
      {
        managedTools: {
          autoInstall: "allow",
          async installAgentReach(input) {
            installCalls.push(input.cwd)
            return { exitCode: 0, stdout: "installed into managed env", stderr: "" }
          },
        },
      },
    )

    const installCall = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call" && event.name === "shell" && event.id !== "call_doctor",
    )
    const installResult = events.find((event) => event.type === "tool_result" && event.name === "shell" && event.id === installCall?.id)
    expect(executedShellCommands).toEqual(["agent-reach doctor --json"])
    expect(installCalls).toHaveLength(1)
    expect(installCall).toMatchObject({
      type: "tool_call",
      input: {
        command: "pixiu tools install agent-reach --yes",
        purpose: "安装 Agent Reach 到 Pixiu 托管工具环境",
      },
    })
    expect(installResult).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "installed into managed env",
      metadata: {
        managedTool: "agent-reach",
        managedToolAutoInstall: true,
        activity: { title: "Installed Agent Reach" },
      },
    })
  })

  test("auto-installs Browser Use when managed tool policy allows it", async () => {
    const executedShellCommands: string[] = []
    const installCalls: string[] = []
    const tools = skillRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "browser-use doctor") {
        return {
          ok: false,
          content: "/bin/sh: 1: browser-use: not found",
          metadata: { command, exitCode: 127 },
        }
      }
      return { ok: false, content: `unexpected command: ${command}`, metadata: { command, exitCode: 1 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "browser-use" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor", name: "shell", input: { command: "browser-use doctor" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: installed" }, { type: "text_end", text: "FINAL: installed" }, { type: "finish", reason: "stop" }],
      ],
      tools,
      {
        managedTools: {
          autoInstall: "allow",
          async installBrowserUse(input) {
            installCalls.push(input.cwd)
            return { exitCode: 0, stdout: "installed browser-use into managed env", stderr: "" }
          },
        },
      },
    )

    const installCall = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call" && event.name === "shell" && event.id !== "call_doctor",
    )
    const installResult = events.find((event) => event.type === "tool_result" && event.name === "shell" && event.id === installCall?.id)
    expect(executedShellCommands).toEqual(["browser-use doctor"])
    expect(installCalls).toHaveLength(1)
    expect(installCall).toMatchObject({
      type: "tool_call",
      input: {
        command: "pixiu tools install browser-use --yes",
        purpose: "安装 browser-use 到 Pixiu 托管工具环境",
      },
    })
    expect(installResult).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "installed browser-use into managed env",
      metadata: {
        managedTool: "browser-use",
        managedToolAutoInstall: true,
        activity: { title: "Installed browser-use" },
      },
    })
  })

  test("blocks fallback commands after Agent Reach route reports login required", async () => {
    const executedShellCommands: string[] = []
    const tools = skillRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "agent-reach doctor --json") {
        return { ok: true, content: "{\"xiaohongshu\":{\"active_backend\":\"xhs-cli\"}}", metadata: { command, exitCode: 0 } }
      }
      if (command === "xhs feed") {
        return {
          ok: false,
          content: "Not logged in. Run `xhs login` first.",
          metadata: { command, exitCode: 1 },
        }
      }
      return { ok: true, content: "unexpected", metadata: { command, exitCode: 0 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor", name: "shell", input: { command: "agent-reach doctor --json" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_feed", name: "shell", input: { command: "xhs feed" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_search", name: "shell", input: { command: "python scrape_xhs_public.py" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: needs login" }, { type: "text_end", text: "FINAL: needs login" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    const blocked = events.find((event) => event.type === "tool_result" && event.id === "call_search")
    expect(executedShellCommands).toEqual(["agent-reach doctor --json", "xhs feed"])
    expect(blocked).toMatchObject({
      type: "tool_result",
      ok: false,
      metadata: {
        skillRouteBlocked: true,
        userActionRequired: true,
        category: "auth",
        blocker: { kind: "user_action_required", skill: "agent-reach", signal: "login_required" },
      },
    })
  })

  test("allows browser-use handoff after Agent Reach route reports login required", async () => {
    const executedShellCommands: string[] = []
    const tools = skillRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "agent-reach doctor --json") {
        return { ok: true, content: "{\"xiaohongshu\":{\"active_backend\":\"xhs-cli\"}}", metadata: { command, exitCode: 0 } }
      }
      if (command === "xhs search 科技") {
        return {
          ok: false,
          content: "Not logged in. Run `xhs login` first.",
          metadata: { command, exitCode: 1 },
        }
      }
      if (command === "browser-use doctor") {
        return { ok: true, content: "browser-use ok", metadata: { command, exitCode: 0 } }
      }
      if (command === "browser-use --headed --session pixiu-xiaohongshu-tech open https://www.xiaohongshu.com") {
        return { ok: true, content: "opened", metadata: { command, exitCode: 0 } }
      }
      return { ok: true, content: "unexpected", metadata: { command, exitCode: 0 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill_agent", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor", name: "shell", input: { command: "agent-reach doctor --json" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_search", name: "shell", input: { command: "xhs search 科技" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_skill_browser", name: "skill", input: { name: "browser-use" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_browser_doctor", name: "shell", input: { command: "browser-use doctor" } } }, { type: "finish", reason: "tool_calls" }],
        [
          {
            type: "tool_call",
            call: {
              id: "call_browser_open",
              name: "shell",
              input: { command: "browser-use --headed --session pixiu-xiaohongshu-tech open https://www.xiaohongshu.com" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: browser route opened" }, { type: "text_end", text: "FINAL: browser route opened" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    expect(executedShellCommands).toEqual([
      "agent-reach doctor --json",
      "xhs search 科技",
      "browser-use doctor",
      "browser-use --headed --session pixiu-xiaohongshu-tech open https://www.xiaohongshu.com",
    ])
    expect(events.find((event) => event.type === "tool_result" && event.id === "call_skill_browser")).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "Loaded browser-use",
    })
    expect(events.find((event) => event.type === "tool_result" && event.id === "call_browser_open")).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "opened",
    })
  })

  test("browser-use missing tool blocker takes over after Agent Reach handoff", async () => {
    const executedShellCommands: string[] = []
    const tools = skillRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "agent-reach doctor --json") {
        return { ok: true, content: "{\"xiaohongshu\":{\"active_backend\":\"xhs-cli\"}}", metadata: { command, exitCode: 0 } }
      }
      if (command === "xhs feed") {
        return {
          ok: false,
          content: "Not logged in. Run `xhs login` first.",
          metadata: { command, exitCode: 1 },
        }
      }
      if (command === "browser-use doctor") {
        return {
          ok: false,
          content: "/bin/sh: 1: browser-use: not found",
          metadata: { command, exitCode: 127 },
        }
      }
      return { ok: true, content: "unexpected", metadata: { command, exitCode: 0 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill_agent", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor", name: "shell", input: { command: "agent-reach doctor --json" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_feed", name: "shell", input: { command: "xhs feed" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_skill_browser", name: "skill", input: { name: "browser-use" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_browser_doctor", name: "shell", input: { command: "browser-use doctor" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_fallback", name: "shell", input: { command: "curl https://r.jina.ai/http://r.jina.ai/http://example.com" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: install browser-use" }, { type: "text_end", text: "FINAL: install browser-use" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    const blocked = events.find((event) => event.type === "tool_result" && event.id === "call_fallback")
    expect(executedShellCommands).toEqual(["agent-reach doctor --json", "xhs feed", "browser-use doctor"])
    expect(blocked).toMatchObject({
      type: "tool_result",
      ok: false,
      metadata: {
        skillRouteBlocked: true,
        blocker: { kind: "missing_managed_tool", skill: "browser-use", tool: "browser-use" },
        activity: {
          details: {
            allowedNext: ["request_user_action", "pixiu tools install browser-use --yes"],
          },
        },
      },
    })
  })

  test("blocks Jina and curl fallbacks once Browser Use skill is loaded", async () => {
    const executedShellCommands: string[] = []
    const tools = skillRouteTools((command) => {
      executedShellCommands.push(command)
      return { ok: true, content: "unexpected", metadata: { command, exitCode: 0 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill_agent", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_skill_browser", name: "skill", input: { name: "browser-use" } } }, { type: "finish", reason: "tool_calls" }],
        [
          {
            type: "tool_call",
            call: {
              id: "call_jina",
              name: "shell",
              input: { command: "curl -s https://r.jina.ai/http://r.jina.ai/http://www.xiaohongshu.com/search_result?keyword=科技" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: blocked" }, { type: "text_end", text: "FINAL: blocked" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    const blocked = events.find((event) => event.type === "tool_result" && event.id === "call_jina")
    expect(executedShellCommands).toEqual([])
    expect(blocked).toMatchObject({
      type: "tool_result",
      ok: false,
      metadata: {
        browserUseRouteBlocked: true,
        skillRouteBlocked: true,
        activity: {
          details: {
            allowedNext: ["browser-use doctor", "browser-use --headed --session <name> open <url>", "browser-use --session <name> state", "request_user_action"],
          },
        },
      },
    })
  })

  test("recovers from empty response after browser-use doctor during handoff", async () => {
    const executedShellCommands: string[] = []
    const tools = skillRouteTools((command) => {
      executedShellCommands.push(command)
      if (command === "agent-reach doctor --json") {
        return { ok: true, content: "{\"xiaohongshu\":{\"active_backend\":\"xhs-cli\"}}", metadata: { command, exitCode: 0 } }
      }
      if (command === "xhs hot") {
        return {
          ok: false,
          content: "Not logged in. Run `xhs login` first.",
          metadata: { command, exitCode: 1 },
        }
      }
      if (command === "browser-use doctor") {
        return { ok: true, content: "browser-use ok", metadata: { command, exitCode: 0 } }
      }
      if (command === "browser-use --headed --session pixiu-xiaohongshu-tech open https://www.xiaohongshu.com") {
        return { ok: true, content: "opened", metadata: { command, exitCode: 0 } }
      }
      return { ok: true, content: "unexpected", metadata: { command, exitCode: 0 } }
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill_agent", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_doctor", name: "shell", input: { command: "agent-reach doctor --json" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_hot", name: "shell", input: { command: "xhs hot" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_skill_browser", name: "skill", input: { name: "browser-use" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_browser_doctor", name: "shell", input: { command: "browser-use doctor" } } }, { type: "finish", reason: "tool_calls" }],
        [],
        [
          {
            type: "tool_call",
            call: {
              id: "call_browser_open",
              name: "shell",
              input: { command: "browser-use --headed --session pixiu-xiaohongshu-tech open https://www.xiaohongshu.com" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: opened after retry" }, { type: "text_end", text: "FINAL: opened after retry" }, { type: "finish", reason: "stop" }],
      ],
      tools,
      { maxSteps: 10 },
    )

    expect(executedShellCommands).toEqual([
      "agent-reach doctor --json",
      "xhs hot",
      "browser-use doctor",
      "browser-use --headed --session pixiu-xiaohongshu-tech open https://www.xiaohongshu.com",
    ])
    expect(events.some((event) => event.type === "error" && event.message.includes("empty response"))).toBe(false)
    expect(events.find((event) => event.type === "tool_result" && event.id === "call_browser_open")).toMatchObject({
      type: "tool_result",
      ok: true,
      content: "opened",
    })
  })

  test("allows request_user_action after Agent Reach route hits QR or captcha blocker", async () => {
    const tools = agentReachRouteTools((command) => {
      if (command === "opencli xiaohongshu feed") {
        return {
          ok: false,
          content: "QR code login required. Please scan QR code in browser.",
          metadata: { command, exitCode: 1 },
        }
      }
      return { ok: true, content: "ok", metadata: { command, exitCode: 0 } }
    }).register({
      name: "request_user_action",
      description: "request user action",
      inputSchema: { type: "object", properties: { title: { type: "string" }, reason: { type: "string" }, instructions: { type: "array", items: { type: "string" } } }, required: ["title", "reason", "instructions"] },
      async execute(input) {
        return {
          ok: true,
          content: String(input.title),
          metadata: {
            userActionRequired: true,
            category: "auth",
            title: String(input.title),
            instructions: Array.isArray(input.instructions) ? input.instructions.filter((item): item is string => typeof item === "string") : [],
          },
        }
      },
    })
    const { events } = await runScriptedToolSequence(
      [
        [{ type: "tool_call", call: { id: "call_skill", name: "skill", input: { name: "agent-reach" } } }, { type: "finish", reason: "tool_calls" }],
        [{ type: "tool_call", call: { id: "call_opencli", name: "shell", input: { command: "opencli xiaohongshu feed" } } }, { type: "finish", reason: "tool_calls" }],
        [
          {
            type: "tool_call",
            call: {
              id: "call_user",
              name: "request_user_action",
              input: {
                title: "需要扫码登录",
                reason: "小红书需要扫码授权。",
                instructions: ["完成扫码登录。"],
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text_start" }, { type: "text_delta", text: "FINAL: waiting" }, { type: "text_end", text: "FINAL: waiting" }, { type: "finish", reason: "stop" }],
      ],
      tools,
    )

    expect(events.find((event) => event.type === "tool_result" && event.id === "call_user")).toMatchObject({
      type: "tool_result",
      ok: true,
      metadata: { userActionRequired: true, category: "auth" },
    })
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

async function runScriptedToolSequence(
  steps: ConstructorParameters<typeof ScriptedLLMClient>[0],
  tools: ToolRegistry,
  options: Partial<ConstructorParameters<typeof AgentRunner>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pixiu-agent-sequence-"))
  const sessions = new MemorySessionStore()
  const runner = new AgentRunner({
    llm: new ScriptedLLMClient(steps),
    tools,
    sessions,
    model: "scripted",
    systemPrompt: "test",
    maxSteps: 8,
    toolContext: {
      cwd: root,
      workspaceRoot: root,
      permissions: new StaticPermissionManager([{ tool: "*", action: "allow" }]),
      pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: true }),
      config: { shellTimeoutMs: 500, outputMaxBytes: 4_000, envAllowlist: ["PATH"] },
    },
    ...options,
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

function skillRouteTools(shellHandler: (command: string) => { ok: boolean; content: string; metadata?: JsonObject }) {
  return new ToolRegistry()
    .register({
      name: "skill",
      description: "load skill",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async execute(input) {
        const name = String(input.name)
        return { ok: true, content: `Loaded ${name}`, metadata: { name } }
      },
    })
    .register({
      name: "shell",
      description: "run shell",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      async execute(input) {
        return shellHandler(String(input.command))
      },
    })
}

const agentReachRouteTools = skillRouteTools

function eventTypesAround(events: AgentEvent[], start: AgentEvent["type"], end: AgentEvent["type"]) {
  const startIndex = events.findIndex((event) => event.type === start)
  const endIndex = events.findIndex((event) => event.type === end)
  return events.slice(startIndex, endIndex + 1).map((event) => event.type)
}

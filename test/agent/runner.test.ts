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

describe("agent runner", () => {
  test("closes a scripted tool-call loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-agent-"))
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

    expect(events.some((event) => event.type === "tool_result" && event.ok)).toBe(true)
    expect(events.some((event) => event.type === "message" && event.content === "pong")).toBe(true)
  })

  test("stops on LLM error events", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-agent-error-"))
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

  test("continues when the assistant returns a non-final draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-agent-continue-"))
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
    const root = await mkdtemp(join(tmpdir(), "minicode-agent-bold-final-"))
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
    const root = await mkdtemp(join(tmpdir(), "minicode-agent-draft-fallback-"))
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
    const root = await mkdtemp(join(tmpdir(), "minicode-agent-late-final-"))
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
})

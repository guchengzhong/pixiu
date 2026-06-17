import { describe, expect, test } from "bun:test"

import {
  activityFromToolIntent,
  activityFromToolResult,
  limitActivityItems,
  normalizeActivityItems,
  normalizePersistedActivityItems,
  stripToolActivityInput,
  updateActivityWithToolResult,
} from "../../src/activity/format"
import type { JsonObject } from "../../src/shared/json"

describe("semantic activity formatter", () => {
  test("creates running intent activity from tool call _activity", () => {
    const item = activityFromToolIntent({
      runId: "run_1",
      sessionId: "session_1",
      toolCallId: "call_weather",
      toolName: "shell",
      input: {
        command: "curl -s https://wttr.in/Wuhan",
        _activity: {
          kind: "search",
          title: "Checking Wuhan weather",
          summary: "Fetching current weather data from wttr.in",
          target: "Wuhan",
        },
      },
      startedAt: "2026-06-17T00:00:00.000Z",
    })

    expect(item).toMatchObject({
      id: "act_run_1_call_weather_shell",
      kind: "search",
      status: "running",
      title: "Checking Wuhan weather",
      summary: "Fetching current weather data from wttr.in",
      target: "Wuhan",
      source: "llm_intent",
    })
  })

  test("strips _activity before executing tools", () => {
    const input: JsonObject = {
      command: "npm run typecheck",
      _activity: { title: "Running TypeScript type check" },
    }
    expect(stripToolActivityInput(input)).toEqual({ command: "npm run typecheck" })
  })

  test("prefers tool metadata activity and attaches run/tool context", () => {
    const item = activityFromToolResult({
      runId: "run_1",
      sessionId: "session_1",
      toolCallId: "call_1",
      toolName: "custom",
      ok: true,
      metadata: {
        activity: {
          kind: "artifact",
          title: "Created artifact",
          summary: "Created report.docx",
          target: "report.docx",
          details: { bytes: 123 },
        },
      },
    })

    expect(item).toMatchObject({
      id: "act_run_1_call_1_custom",
      runId: "run_1",
      sessionId: "session_1",
      toolCallId: "call_1",
      toolName: "custom",
      kind: "artifact",
      status: "success",
      title: "Created artifact",
      summary: "Created report.docx",
      target: "report.docx",
      details: { bytes: 123 },
      source: "tool_metadata",
    })
    expect(item.rawEventIds).toEqual(["tool_call:call_1", "tool_result:call_1"])
  })

  test("falls back conservatively for unknown tools", () => {
    const item = activityFromToolResult({
      runId: "run_1",
      toolCallId: "call_2",
      toolName: "mcp.weather",
      ok: true,
    })

    expect(item).toMatchObject({
      kind: "tool",
      status: "success",
      title: "Used tool: mcp.weather",
    })
  })

  test("maps shell success and failure statuses", () => {
    expect(activityFromToolResult({
      toolCallId: "call_1",
      toolName: "shell",
      input: { command: "npm run typecheck" },
      ok: true,
    })).toMatchObject({
      kind: "shell",
      status: "success",
      title: "Ran command",
      command: "npm run typecheck",
    })

    expect(activityFromToolResult({
      toolCallId: "call_2",
      toolName: "shell",
      input: { command: "bun test" },
      ok: false,
      metadata: { exitCode: 127 },
    })).toMatchObject({
      kind: "shell",
      status: "error",
      title: "Command failed",
      command: "bun test",
      details: { exitCode: 127 },
    })
  })

  test("uses deterministic weather intent for wttr.in shell commands without LLM intent", () => {
    expect(activityFromToolResult({
      toolCallId: "call_wttr",
      toolName: "shell",
      ok: true,
      metadata: {
        command: "curl -s 'wttr.in/无锡?lang=zh'",
        activity: {
          kind: "shell",
          title: "Ran command",
          summary: "Ran curl -s 'wttr.in/无锡?lang=zh'",
          command: "curl -s 'wttr.in/无锡?lang=zh'",
          status: "success",
        },
      },
    })).toMatchObject({
      kind: "search",
      status: "success",
      title: "Checked 无锡 weather",
      summary: "Fetched current weather data from wttr.in",
      target: "无锡",
      command: "curl -s 'wttr.in/无锡?lang=zh'",
      source: "fallback",
    })
  })

  test("updates intent activity with tool result status and metadata details", () => {
    const intent = activityFromToolIntent({
      runId: "run_1",
      toolCallId: "call_weather",
      toolName: "shell",
      input: {
        command: "curl -s https://wttr.in/Wuhan",
        _activity: {
          kind: "search",
          title: "Checking Wuhan weather",
          summary: "Fetching current weather data from wttr.in",
          target: "Wuhan",
        },
      },
    })!
    const result = activityFromToolResult({
      runId: "run_1",
      toolCallId: "call_weather",
      toolName: "shell",
      ok: true,
      metadata: {
        command: "curl -s https://wttr.in/Wuhan",
        activity: {
          summary: "Fetched current weather data from wttr.in",
          details: { provider: "wttr.in" },
        },
      },
      endedAt: "2026-06-17T00:00:01.000Z",
    })

    expect(updateActivityWithToolResult(intent, result, true)).toMatchObject({
      id: intent.id,
      status: "success",
      title: "Checked Wuhan weather",
      summary: "Fetched current weather data from wttr.in",
      target: "Wuhan",
      command: "curl -s https://wttr.in/Wuhan",
      details: { provider: "wttr.in" },
      source: "llm_intent",
    })
  })

  test("updates intent activity to error or skipped based on tool result", () => {
    const intent = activityFromToolIntent({
      toolCallId: "call_weather",
      toolName: "shell",
      input: { command: "curl bad", _activity: { kind: "search", title: "Checking Wuhan weather" } },
    })!

    const failed = activityFromToolResult({ toolCallId: "call_weather", toolName: "shell", ok: false })
    expect(updateActivityWithToolResult(intent, failed, false)).toMatchObject({
      status: "error",
      title: "Failed to check Wuhan weather",
    })

    const denied = activityFromToolResult({
      toolCallId: "call_weather",
      toolName: "shell",
      ok: false,
      metadata: { permissionAction: "deny" },
    })
    expect(updateActivityWithToolResult(intent, denied, false)).toMatchObject({
      status: "skipped",
      title: "Checking Wuhan weather",
    })
  })

  test("normalizes persisted activity and limits growth", () => {
    const items = Array.from({ length: 105 }, (_, index) => ({
      id: `act_${index}`,
      kind: "tool",
      status: "success",
      title: `Tool ${index}`,
    }))

    expect(limitActivityItems(items as any)).toHaveLength(100)
    expect(limitActivityItems(items as any)[0]?.id).toBe("act_5")
    expect(normalizeActivityItems([{ id: "ok", kind: "file", status: "success", title: "Read file" }, { broken: true }])).toEqual([
      { id: "ok", kind: "file", status: "success", title: "Read file" },
    ])
    expect(normalizePersistedActivityItems([{ id: "stale", kind: "search", status: "running", title: "Checking weather" }])).toEqual([
      { id: "stale", kind: "search", status: "cancelled", title: "Checking weather" },
    ])
  })
})

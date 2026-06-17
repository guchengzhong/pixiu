import { describe, expect, test } from "bun:test"

import { createUiApiClient, resolveUiToken } from "../../src/ui/client/api"
import { groupActivityForDisplay, isPrimaryActivity } from "../../src/ui/client/activity"
import { assistantTextFromRunResult, failureMessageFromAgentEvent, streamDisconnectMessage } from "../../src/ui/client/helpers"
import { redactUiText } from "../../src/ui/client/redact"
import { deriveExecutionTimeline, summarizeShellCommand } from "../../src/ui/client/timeline"
import { currentTodoIdFromTodos, normalizeTodos, todoMarker, todoProgress, todoUpdateMatchesSession } from "../../src/ui/client/todos"
import { isActiveRunStatus, normalizePersistedRunStatus, normalizeRunStatus, runStatusLabel } from "../../src/run/status"
import { activityFromToolResult, activityStatusMarker, normalizeActivityItems } from "../../src/activity/format"
import type { AgentEvent } from "../../src/agent/events"
import type { TodoItem } from "../../src/todo/types"

describe("ui client", () => {
  test("sends the local token through the API client", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = []
    const client = createUiApiClient("local-token", async (path, init) => {
      calls.push({ path: String(path), init })
      return Response.json({ ok: true, data: { version: "0", cwd: "/tmp", provider: { model: "m", credential: "none", keyPresent: false }, workspace: {}, sessionsPath: "", skills: {}, mcp: {} } })
    })

    await client.status()

    expect(calls[0]?.path).toBe("/api/status")
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer local-token")
  })

  test("falls back to the URL token when the injected token is missing", () => {
    expect(resolveUiToken(undefined, "?token=url-token")).toBe("url-token")
    expect(resolveUiToken("injected-token", "?token=url-token")).toBe("injected-token")
  })

  test("sends the local token through multipart uploads", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = []
    const client = createUiApiClient("local-token", async (path, init) => {
      calls.push({ path: String(path), init })
      return Response.json({ ok: true, data: { files: [] } })
    })

    await client.uploadFiles("session_upload", [new File(["hello"], "hello.txt")])

    expect(calls[0]?.path).toBe("/api/sessions/session_upload/uploads?token=local-token")
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer local-token")
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData)
  })

  test("throws API errors with the server message", async () => {
    const client = createUiApiClient("local-token", async () => Response.json({ ok: false, code: "NOPE", message: "broken" }, { status: 500 }))

    await expect(client.status()).rejects.toThrow("broken")
  })

  test("normalizes and labels run status values", () => {
    expect(normalizeRunStatus("waiting_permission")).toBe("waiting_for_permission")
    expect(normalizeRunStatus("done")).toBe("idle")
    expect(normalizePersistedRunStatus("running")).toBe("idle")
    expect(normalizePersistedRunStatus("waiting_for_permission")).toBe("idle")
    expect(isActiveRunStatus("queued")).toBe(true)
    expect(isActiveRunStatus("idle")).toBe(false)
    expect(runStatusLabel("queued")).toBe("Starting")
    expect(runStatusLabel("running")).toBe("Working")
    expect(runStatusLabel("waiting_for_permission")).toBe("Waiting for permission")
    expect(runStatusLabel("idle")).toBe("Ready")
    expect(runStatusLabel("error")).toBe("Error")
    expect(runStatusLabel("cancelled")).toBe("Cancelled")
  })

  test("prefers real agent failures over generic stream disconnect copy", () => {
    const toolFailure = failureMessageFromAgentEvent({
      type: "tool_result",
      id: "call_web",
      name: "web_search",
      ok: false,
      content: "fetch failed: 503 Service Unavailable",
    })
    const agentFailure = failureMessageFromAgentEvent({ type: "error", message: "Provider request failed" })

    expect(toolFailure).toBe("web_search failed: fetch failed: 503 Service Unavailable")
    expect(agentFailure).toBe("Provider request failed")
    expect(streamDisconnectMessage(toolFailure)).toBe("web_search failed: fetch failed: 503 Service Unavailable")
    expect(streamDisconnectMessage()).toBe("Run event stream disconnected.")
  })

  test("renders error run results from result.error or the last tool failure", () => {
    expect(assistantTextFromRunResult({ answer: "final answer", status: "error", finishReason: "error", error: "hidden" })).toBe("final answer")
    expect(assistantTextFromRunResult({ answer: "", status: "error", finishReason: "error", error: "Provider failed" })).toBe("Error: Provider failed")
    expect(assistantTextFromRunResult({ answer: "", status: "error", finishReason: "error" }, "web_search failed: timeout")).toBe(
      "Error: web_search failed: timeout",
    )
    expect(assistantTextFromRunResult({ answer: "", status: "cancelled", finishReason: "cancelled" })).toBe("Cancelled.")
    expect(assistantTextFromRunResult({ answer: "", status: "idle", finishReason: "stop" })).toBe("(no answer)")
  })

  test("normalizes semantic activity and rejects run lifecycle statuses", () => {
    const activity = normalizeActivityItems([
      { id: "read", kind: "file", status: "success", title: "Read file", target: "README.md" },
      { id: "perm", kind: "permission", status: "running", title: "Waiting for permission" },
      { id: "queued", kind: "system", status: "queued", title: "Starting" },
      { id: "bad", status: "idle", title: "Ready" },
    ])

    expect(activity).toEqual([
      { id: "read", kind: "file", status: "success", title: "Read file", target: "README.md" },
      { id: "perm", kind: "permission", status: "running", title: "Waiting for permission" },
    ])
    expect(activityStatusMarker("success")).toBe("✓")
    expect(activityStatusMarker("error")).toBe("✕")
    expect(activityFromToolResult({ toolCallId: "call", toolName: "unknown_tool", ok: true }).title).toBe("Used tool: unknown_tool")
  })

  test("groups activity so intent items lead and raw-ish run details are secondary", () => {
    const weather = {
      id: "weather",
      kind: "search" as const,
      status: "success" as const,
      title: "Checked 武汉 weather",
      summary: "Fetched current weather data from wttr.in",
      source: "fallback" as const,
    }
    const command = {
      id: "cmd",
      kind: "shell" as const,
      status: "success" as const,
      title: "Ran command",
      summary: "Ran python3 /tmp/parse_weather.py",
      command: "python3 /tmp/parse_weather.py",
      source: "tool_metadata" as const,
    }
    const permission = {
      id: "perm",
      kind: "permission" as const,
      status: "success" as const,
      title: "Permission approved",
    }
    const tempFile = {
      id: "tmp",
      kind: "file" as const,
      status: "success" as const,
      title: "Updated file",
      target: "../../../../tmp/parse_weather.py",
    }

    const grouped = groupActivityForDisplay([permission, weather, command, tempFile])

    expect(isPrimaryActivity(weather)).toBe(true)
    expect(grouped.primary.map((item) => item.id)).toEqual(["weather"])
    expect(grouped.secondary.map((item) => item.id)).toEqual(["tmp", "cmd", "perm"])
  })

  test("redacts common secret shapes before rendering trace text", () => {
    const redacted = redactUiText("Authorization: Bearer sk-12345678901234567890\nAPI_KEY=abc123")

    expect(redacted).not.toContain("sk-12345678901234567890")
    expect(redacted).not.toContain("abc123")
    expect(redacted).toContain("[redacted]")
  })

  test("normalizes missing session todos to an empty list", () => {
    expect(normalizeTodos(undefined)).toEqual([])
  })

  test("summarizes todo progress and current task", () => {
    const todos: TodoItem[] = [
      { id: "inspect", content: "Inspect workspace", status: "completed", priority: "high" },
      { id: "ui", content: "Update UI progress", status: "in_progress", priority: "medium" },
      { id: "verify", content: "Verify behavior", status: "pending", priority: "low" },
      { id: "skip", content: "Skip obsolete path", status: "cancelled", priority: "low" },
    ]

    expect(todoProgress(todos)).toMatchObject({
      total: 4,
      completed: 1,
      inProgress: 1,
      pending: 1,
      cancelled: 1,
      current: todos[1],
    })
    expect(currentTodoIdFromTodos(todos)).toBe("ui")
    expect(todoMarker("completed")).toBe("✓")
    expect(todoMarker("in_progress")).toBe("●")
    expect(todoMarker("pending")).toBe("○")
    expect(todoMarker("cancelled")).toBe("×")
  })

  test("only applies live todo events for the selected session", () => {
    const event: AgentEvent = {
      type: "todo_updated",
      sessionId: "session_a",
      todos: [{ id: "a", content: "Current session task", status: "in_progress", priority: "high" }],
      currentTodoId: "a",
    }

    expect(todoUpdateMatchesSession(event, "session_a")).toBe(true)
    expect(todoUpdateMatchesSession(event, "session_b")).toBe(false)
    expect(todoUpdateMatchesSession(event, undefined)).toBe(false)
  })

  test("derives semantic timeline titles while retaining raw trace details", () => {
    const timeline = deriveExecutionTimeline([
      {
        id: "result_write",
        title: "ok write",
        kind: "result",
        detail: JSON.stringify({ ok: true, content: "Changed src/app.ts", metadata: { path: "src/app.ts" } }, null, 2),
      },
      {
        id: "call_write",
        title: "tool write",
        kind: "call",
        detail: JSON.stringify({ path: "src/app.ts", content: "hello" }, null, 2),
      },
      {
        id: "result_shell",
        title: "failed shell",
        kind: "result",
        failed: true,
        detail: JSON.stringify({ ok: false, content: "exitCode: 1\nstderr", metadata: { command: "bun test", exitCode: 1 } }, null, 2),
      },
      {
        id: "call_shell",
        title: "tool shell",
        kind: "call",
        detail: JSON.stringify({ command: "bun test" }, null, 2),
      },
    ])

    expect(timeline.map((item) => item.title)).toEqual(["Updated file: src/app.ts", "Command failed"])
    expect(timeline[0]?.title).not.toBe("ok write")
    expect(timeline[1]?.title).not.toBe("tool shell")
    expect(timeline[1]?.status).toBe("failed")
    expect(timeline[1]?.subtitle).toBe("bun test")
    expect(timeline[0]?.raw.map((item) => item.title)).toEqual(["tool write", "ok write"])
    expect(timeline[1]?.raw.map((item) => item.title)).toEqual(["tool shell", "failed shell"])
  })

  test("derives readable timeline entries for common tools and empty trace", () => {
    expect(deriveExecutionTimeline([])).toEqual([])
    expect(deriveExecutionTimeline([{ id: "read", title: "tool read", kind: "call", detail: JSON.stringify({ path: "README.md" }) }])[0]).toMatchObject({
      title: "Read file: README.md",
      status: "running",
    })
    expect(deriveExecutionTimeline([{ id: "todo", title: "ok todowrite", kind: "result", detail: JSON.stringify({ ok: true, metadata: { todos: [{ id: "a" }] } }) }])[0]).toMatchObject({
      title: "Updated task plan",
      status: "success",
      subtitle: "1 tasks",
    })
    expect(deriveExecutionTimeline([{ id: "skill", title: "tool skill", kind: "call", detail: JSON.stringify({ name: "pixiu-frontend-workbench" }) }])[0]?.title).toBe("Loaded skill: pixiu-frontend-workbench")
    expect(deriveExecutionTimeline([{ id: "web", title: "tool web_search", kind: "call", detail: JSON.stringify({ query: "pixiu agent" }) }])[0]?.title).toBe("Searching web: pixiu agent")
  })

  test("summarizes common shell command intents conservatively", () => {
    expect(summarizeShellCommand("wc -l docs/todo.md", { content: "42 docs/todo.md\n" }, "success")).toMatchObject({
      title: "Counted lines",
      subtitle: "42 lines in docs/todo.md",
    })
    expect(summarizeShellCommand('python -c "import PyPDF2"', undefined, "success")).toMatchObject({
      title: "Checked Python package",
      subtitle: "PyPDF2",
    })
    expect(summarizeShellCommand("which pdftotext", undefined, "success")).toMatchObject({
      title: "Checked command availability",
      subtitle: "pdftotext",
    })
    expect(summarizeShellCommand("apt-get install pdftotext", undefined, "failed")).toMatchObject({
      title: "Failed to install package",
      subtitle: "pdftotext",
    })
    expect(summarizeShellCommand("pip install pymupdf 2> install.log", undefined, "success")).toMatchObject({
      title: "Installed package",
      subtitle: "pymupdf",
    })
    expect(summarizeShellCommand("some-custom-command --flag", undefined, "success")).toMatchObject({
      title: "Command completed",
      subtitle: "some-custom-command --flag",
    })
  })

  test("derives command intent titles from paired shell traces and keeps raw details", () => {
    const timeline = deriveExecutionTimeline([
      {
        id: "result_wc",
        title: "ok shell",
        kind: "result",
        detail: JSON.stringify({ ok: true, content: "12 README.md\n", metadata: { command: "wc -l README.md" } }, null, 2),
      },
      {
        id: "call_wc",
        title: "tool shell",
        kind: "call",
        detail: JSON.stringify({ command: "wc -l README.md" }, null, 2),
      },
      {
        id: "result_unknown",
        title: "ok shell",
        kind: "result",
        detail: JSON.stringify({ ok: true, content: "done", metadata: { command: "custom --thing" } }, null, 2),
      },
      {
        id: "call_unknown",
        title: "tool shell",
        kind: "call",
        detail: JSON.stringify({ command: "custom --thing" }, null, 2),
      },
    ])

    expect(timeline[0]).toMatchObject({
      title: "Counted lines",
      subtitle: "12 lines in README.md",
      status: "success",
    })
    expect(timeline[1]).toMatchObject({
      title: "Command completed",
      subtitle: "custom --thing",
      status: "success",
    })
    expect(timeline[0]?.raw.map((item) => item.title)).toEqual(["tool shell", "ok shell"])
  })

  test("polishes run and permission timeline noise", () => {
    const timeline = deriveExecutionTimeline([
      {
        id: "run",
        title: "Run finished",
        detail: "status: idle\nfinishReason: stop\nsessionId: session_123",
      },
      {
        id: "permission",
        title: "permission",
        kind: "permission",
        detail: JSON.stringify({ id: "perm_1", action: "allow", request: { tool: "shell" }, scope: "sessionSimilar" }, null, 2),
      },
    ])

    expect(timeline[0]).toMatchObject({
      title: "Run completed",
      subtitle: "Finished normally",
      status: "success",
    })
    expect(timeline[1]).toMatchObject({
      title: "Permission allowed",
      subtitle: "shell · sessionSimilar",
      status: "success",
    })
    expect(timeline[1]?.raw[0]?.title).toBe("permission")
  })
})

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createUiServer } from "../../src/ui/server/server"
import { createFakeLLMServer } from "../harness/llm-server"

async function json(response: Response) {
  return await response.json() as any
}

async function sse(response: Response) {
  const text = await response.text()
  return text
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const event = chunk.match(/^event: (.+)$/m)?.[1]
      const data = chunk.match(/^data: (.+)$/m)?.[1]
      return { event, data: data ? JSON.parse(data) : undefined }
    })
}

async function readUntil(response: Response, pattern: string) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("missing response body")
  const decoder = new TextDecoder()
  let text = ""
  while (text.indexOf(pattern) === -1 || text.indexOf("\n\n", text.indexOf(pattern)) === -1) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  return { text, rest: new Response(new ReadableStream({
    start(controller) {
      const pump = async () => {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          controller.enqueue(chunk.value)
        }
        controller.close()
      }
      pump().catch((error) => controller.error(error))
    },
  })).text().then((tail) => text + tail) }
}

describe("ui server", () => {
  test("serves the chat workspace page without requiring an API token", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-page-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/")
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(html).toContain('<div id="root"></div>')
      expect(html).toContain("/assets/client.css")
      expect(html).toContain("/assets/client.js")

      const bundle = await ui.fetch("http://127.0.0.1/assets/client.js")
      const js = await bundle.text()
      const css = await ui.fetch("http://127.0.0.1/assets/client.css")

      expect(bundle.status).toBe(200)
      expect(bundle.headers.get("content-type")).toContain("text/javascript")
      expect(js).toContain("How can Pixiu help?")
      expect(js).toContain("Configure API")
      expect(js).toContain("Message Pixiu")
      expect(css.status).toBe(200)
      expect(css.headers.get("content-type")).toContain("text/css")
    } finally {
      await ui.close()
    }
  })

  test("requires a local token for API routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-token-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/status")
      const body = await json(response)

      expect(response.status).toBe(401)
      expect(body).toMatchObject({ ok: false, code: "UNAUTHORIZED" })
    } finally {
      await ui.close()
    }
  })

  test("returns status with provider and workspace summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-status-"))
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "provider/model",
        providers: {
          "openai-compatible": {
            baseURL: "https://api.example.test/v1",
            apiKeyEnv: "PIXIU_TEST_KEY",
            model: "provider/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/status", {
        headers: { authorization: "Bearer test-token" },
      })
      const body = await json(response)

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        ok: true,
        data: {
          cwd: root,
          provider: {
            baseURL: "https://api.example.test/v1",
            model: "provider/model",
            credential: "apiKeyEnv",
            apiKeyEnv: "PIXIU_TEST_KEY",
          },
          workspace: {
            mode: "workspace",
            workspaceDir: "workspace",
          },
        },
      })
    } finally {
      await ui.close()
    }
  })

  test("redacts API keys from config responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-config-"))
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        providers: {
          "openai-compatible": {
            baseURL: "https://api.example.test/v1",
            apiKey: "sk-test-secret-value",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/config?token=test-token")
      const body = await json(response)

      expect(response.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.data.config.providers["openai-compatible"].apiKey).toBe("[redacted]")
      expect(JSON.stringify(body)).not.toContain("sk-test-secret-value")
    } finally {
      await ui.close()
    }
  })

  test("returns session summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-sessions-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      await ui.fetch("http://127.0.0.1/api/status", {
        headers: { authorization: "Bearer test-token" },
      })
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({
          id: "session_test",
          cwd: join(root, "workspace/session_test"),
          title: "UI session",
          metadata: { workspaceDir: "workspace/session_test" },
        })
      } finally {
        await built.close()
      }

      const response = await ui.fetch("http://127.0.0.1/api/sessions", {
        headers: { authorization: "Bearer test-token" },
      })
      const body = await json(response)

      expect(response.status).toBe(200)
      expect(body.data.sessions).toContainEqual(
        expect.objectContaining({
          id: "session_test",
          title: "UI session",
          workspaceDir: "workspace/session_test",
        }),
      )
    } finally {
      await ui.close()
    }
  })

  test("manages projects and session lifecycle through the UI API", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-projects-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const projects = await json(await ui.fetch("http://127.0.0.1/api/projects", {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(projects.status).not.toBe(500)
      expect(projects.data.projects).toContainEqual(expect.objectContaining({
        id: "project_default",
        name: expect.any(String),
        rootPath: root,
        sessionCount: 0,
      }))

      const createdProject = await json(await ui.fetch("http://127.0.0.1/api/projects", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ name: "Research" }),
      }))
      const projectId = createdProject.data.project.id
      const renamedProject = await json(await ui.fetch(`http://127.0.0.1/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ name: "Research Lab" }),
      }))
      const selectedProject = await json(await ui.fetch(`http://127.0.0.1/api/projects/${projectId}/select`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      }))
      const createdSession = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "Lifecycle chat", projectId }),
      }))
      const sessionId = createdSession.data.session.id
      const nonEmptyDelete = await json(await ui.fetch(`http://127.0.0.1/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer test-token" },
      }))
      const renamedSession = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed chat" }),
      }))
      const moved = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/move`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ projectId: "project_default" }),
      }))
      const deletedProject = await json(await ui.fetch(`http://127.0.0.1/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer test-token" },
      }))
      const deletedSession = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer test-token" },
      }))
      const sessionsAfterDelete = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(createdProject.data.project).toMatchObject({ name: "Research", sessionCount: 0 })
      expect(renamedProject.data.project).toMatchObject({ name: "Research Lab" })
      expect(selectedProject.data.project.id).toBe(projectId)
      expect(createdSession.data.session).toMatchObject({ title: "Lifecycle chat", projectId })
      expect(nonEmptyDelete).toMatchObject({ ok: false, code: "PROJECT_NOT_EMPTY" })
      expect(renamedSession.data.session).toMatchObject({ title: "Renamed chat", titleSource: "user" })
      expect(moved.data.session).toMatchObject({ projectId: "project_default" })
      expect(deletedProject.data.project.id).toBe(projectId)
      expect(deletedSession.data.session.id).toBe(sessionId)
      expect(sessionsAfterDelete.data.sessions.some((session: any) => session.id === sessionId)).toBe(false)
    } finally {
      await ui.close()
    }
  })

  test("assigns legacy sessions without projectId to the default project", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-legacy-project-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({
          id: "session_legacy",
          cwd: join(root, "workspace/session_legacy"),
          title: "Legacy chat",
          metadata: { workspaceDir: "workspace/session_legacy" },
        })
      } finally {
        await built.close()
      }

      const sessions = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        headers: { authorization: "Bearer test-token" },
      }))
      const projects = await json(await ui.fetch("http://127.0.0.1/api/projects", {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(sessions.data.sessions[0]).toMatchObject({ id: "session_legacy", projectId: "project_default" })
      expect(projects.data.projects.find((project: any) => project.id === "project_default")).toMatchObject({
        sessionCount: 1,
        lastSessionId: "session_legacy",
      })
    } finally {
      await ui.close()
    }
  })

  test("saves provider config from the UI API", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-save-config-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/config/provider", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          baseURL: "siliconflow",
          model: "provider/model",
          credential: "apiKey",
          apiKey: "sk-test-secret-value",
        }),
      })
      const body = await json(response)
      const saved = await readFile(join(root, "pixiu.jsonc"), "utf8")

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        ok: true,
        data: {
          provider: {
            baseURL: "https://api.siliconflow.cn/v1",
            model: "provider/model",
            credential: "apiKey",
            keyPresent: true,
          },
        },
      })
      expect(saved).toContain('"apiKey": "sk-test-secret-value"')
    } finally {
      await ui.close()
    }
  })

  test("tests the configured provider from the UI API", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-test-provider-"))
    const llm = await createFakeLLMServer()
    llm.text("ok")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/config/test-provider", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      })
      const body = await json(response)

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        ok: true,
        data: {
          ok: true,
          model: "fake/model",
          text: "ok",
        },
      })
      expect(llm.calls()).toBe(1)
      expect(llm.inputs()[0]?.tool_choice).toBe("none")
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("reports a missing provider key when testing provider connectivity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-test-provider-missing-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/config/test-provider", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      })
      const body = await json(response)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ ok: false, code: "PROVIDER_API_KEY_MISSING" })
    } finally {
      await ui.close()
    }
  })

  test("creates an empty chat session with a workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-create-session-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "Browser chat" }),
      })
      const body = await json(response)

      expect(response.status).toBe(200)
      expect(body.data.session).toMatchObject({
        title: "Browser chat",
        workspaceDir: expect.stringContaining("workspace/session_"),
      })
      expect(body.data.session.id).toStartWith("session_")
      expect(body.data.files).toEqual([])
    } finally {
      await ui.close()
    }
  })

  test("runs a chat message through the configured provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-run-"))
    const llm = await createFakeLLMServer()
    llm.text("FINAL: hello from ui")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "say hi", permissionMode: "acceptEdits" }),
      })
      const body = await json(response)

      expect(response.status).toBe(200)
      expect(body.data.answer).toBe("hello from ui")
      expect(body.data.sessionId).toStartWith("session_")
      const listed = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        headers: { authorization: "Bearer test-token" },
      }))
      expect(listed.data.sessions[0]).toMatchObject({ model: "fake/model", finishStatus: "idle" })
      expect(llm.calls()).toBe(1)
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("serializes runs on the same session, superseding an in-flight run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-serial-"))
    const llm = await createFakeLLMServer()
    llm.hang() // first run stalls mid-request until it is aborted by the second run
    llm.text("FINAL: second answer")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: { "openai-compatible": { baseURL: llm.url, apiKey: "sk-test", model: "fake/model" } },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const created = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "serial" }),
      }))
      const sessionId = created.data.session.id

      // Start the first run and let it reach the (hanging) provider request.
      await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "first", sessionId, permissionMode: "acceptEdits" }),
      })
      await llm.wait(1)

      // A second run on the same session aborts the first and runs after it settles.
      const second = await json(await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "second", sessionId, permissionMode: "acceptEdits" }),
      }))

      expect(second.data.answer).toBe("second answer")
      expect(second.data.status).toBe("idle")

      // The persisted history must be free of interleaving/orphans: no assistant message
      // may declare a tool_call, and there is exactly one assistant answer ("second").
      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}`, {
        headers: { authorization: "Bearer test-token" },
      }))
      const assistants = detail.data.messages.filter((m: any) => m.role === "assistant")
      expect(assistants.length).toBe(1)
      expect(assistants[0].parts.some((p: any) => p.type === "tool_call")).toBe(false)
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("session detail includes persisted todos", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-session-todos-"))
    const llm = await createFakeLLMServer()
    llm.tool("todowrite", {
      todos: [
        { id: "plan", content: "Plan work", status: "completed", priority: "high" },
        { id: "verify", content: "Verify work", status: "in_progress", priority: "medium" },
      ],
    })
    llm.text("FINAL: todos saved")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "track todos", permissionMode: "acceptEdits" }),
      })
      const body = await json(response)
      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${body.data.sessionId}`, {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(response.status).toBe(200)
      expect(body.data.events.some((event: any) => event.type === "todo_updated" && event.currentTodoId === "verify")).toBe(true)
      expect(detail.data.todos).toEqual([
        { id: "plan", content: "Plan work", status: "completed", priority: "high" },
        { id: "verify", content: "Verify work", status: "in_progress", priority: "medium" },
      ])
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("streams run events over SSE", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-run-sse-"))
    const llm = await createFakeLLMServer()
    llm.text("FINAL: streamed hello")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const start = await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "stream please", permissionMode: "acceptEdits" }),
      })
      const started = await json(start)
      const stream = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/events?token=test-token`)
      const events = await sse(stream)
      const runStatuses = events
        .filter((event) => event.event === "run_status")
        .map((event) => event.data.status)

      expect(start.status).toBe(200)
      expect(runStatuses).toEqual(["queued", "running", "idle"])
      expect(events.some((event) => event.event === "run" && event.data.status === "done" && event.data.runStatus === "idle")).toBe(true)
      expect(events.some((event) => event.event === "agent_event" && event.data.type === "llm_text_delta")).toBe(true)
      expect(events.at(-1)).toMatchObject({
        event: "result",
        data: expect.objectContaining({ answer: "streamed hello", status: "idle" }),
      })
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("reports provider failures as error run status", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-run-error-"))
    const llm = await createFakeLLMServer()
    llm.error(500, { error: "provider exploded" })
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "fail please", permissionMode: "acceptEdits" }),
      })
      const body = await json(response)

      expect(response.status).toBe(200)
      expect(body.data.status).toBe("error")
      expect(body.data.finishReason).toBe("error")
      expect(body.data.events.some((event: any) => event.type === "error")).toBe(true)
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("cancels an active run and emits cancelled status", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-run-cancel-"))
    const llm = await createFakeLLMServer()
    llm.hang()
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const start = await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "hang then cancel", permissionMode: "acceptEdits" }),
      })
      const started = await json(start)
      const stream = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/events?token=test-token`)
      const partial = await readUntil(stream, '"status":"running"')
      const cancel = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/cancel`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      })
      const all = await partial.rest

      expect(cancel.status).toBe(200)
      expect(all).toContain('"status":"cancelled"')
      expect(all).toContain('"finishReason":"cancelled"')
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("cleans up SSE subscribers when the client disconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-run-sse-disconnect-"))
    const llm = await createFakeLLMServer()
    llm.text("FINAL: slow hello", { delayMs: 40 })
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const start = await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "stream then disconnect", permissionMode: "acceptEdits" }),
      })
      const started = await json(start)
      const controller = new AbortController()
      const stream = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/events?token=test-token`, {
        signal: controller.signal,
      })
      controller.abort()
      await stream.text().catch(() => undefined)
      const result = await json(await ui.fetch(`http://127.0.0.1/api/runs?wait=1`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "second run after disconnect", permissionMode: "acceptEdits" }),
      }))

      expect(result.data.status).toBe("idle")
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("runs a fake provider write tool flow and exposes artifact evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-write-tool-"))
    const llm = await createFakeLLMServer()
    llm.tool("write", { path: "report.md", content: "# Report\nfrom ui" })
    llm.text("FINAL: wrote report")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "write report", permissionMode: "acceptEdits" }),
      })
      const body = await json(response)
      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${body.data.sessionId}`, {
        headers: { authorization: "Bearer test-token" },
      }))
      const preview = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${body.data.sessionId}/files/content?path=report.md`, {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(response.status).toBe(200)
      expect(body.data.answer).toBe("wrote report")
      expect(detail.data.activity).toContainEqual(expect.objectContaining({
        kind: "file",
        status: "success",
        title: "Updated file",
        target: "report.md",
        runId: body.data.runId,
        sessionId: body.data.sessionId,
        toolCallId: "call_1",
        toolName: "write",
      }))
      expect(detail.data.evidence.artifacts).toContainEqual(expect.objectContaining({ tool: "write", path: "report.md" }))
      expect(preview.data.content).toContain("# Report")
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("streams semantic activity updates while preserving raw tool trace and run status", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-activity-sse-"))
    const llm = await createFakeLLMServer()
    llm.tool("read", { path: "note.txt" })
    llm.text("FINAL: read note")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const created = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "Read activity" }),
      }))
      const sessionId = created.data.session.id
      await writeFile(join(root, created.data.session.workspaceDir, "note.txt"), "hello activity", "utf8")
      const start = await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "read note", sessionId, permissionMode: "acceptEdits" }),
      })
      const started = await json(start)
      const stream = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/events?token=test-token`)
      const events = await sse(stream)
      const activityEvents = events.filter((event) => event.event === "activity_updated")

      expect(activityEvents).toHaveLength(1)
      expect(activityEvents[0]?.data.item).toMatchObject({
        kind: "file",
        status: "success",
        title: "Read file",
        target: "note.txt",
        runId: started.data.runId,
        sessionId,
        toolCallId: "call_1",
        toolName: "read",
      })
      expect(activityEvents[0]?.data.activity).toHaveLength(1)
      expect(events.some((event) => event.event === "agent_event" && event.data.type === "tool_call")).toBe(true)
      expect(events.some((event) => event.event === "agent_event" && event.data.type === "tool_result")).toBe(true)
      expect(events.filter((event) => event.event === "run_status").map((event) => event.data.status)).toEqual(["queued", "running", "idle"])
      expect(events.some((event) => event.event === "todo_updated")).toBe(false)
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("streams LLM intent activity for tool calls and updates the same item on result", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-activity-intent-"))
    const llm = await createFakeLLMServer()
    llm.tool("shell", {
      command: "printf 'sunny 28C'",
      _activity: {
        kind: "search",
        title: "Checking Wuhan weather",
        summary: "Fetching current weather data from wttr.in",
        target: "Wuhan",
      },
    })
    llm.text("FINAL: sunny")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const start = await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "weather", permissionMode: "bypassPermissions" }),
      })
      const started = await json(start)
      const stream = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/events?token=test-token`)
      const events = await sse(stream)
      const activityEvents = events.filter((event) => event.event === "activity_updated")
      const rawCall = events.find((event) => event.event === "agent_event" && event.data.type === "tool_call")

      expect(activityEvents).toHaveLength(2)
      expect(activityEvents[0]?.data.item).toMatchObject({
        id: activityEvents[1]?.data.item.id,
        kind: "search",
        status: "running",
        title: "Checking Wuhan weather",
        source: "llm_intent",
      })
      expect(activityEvents[1]?.data.item).toMatchObject({
        kind: "search",
        status: "success",
        title: "Checked Wuhan weather",
        summary: "Fetching current weather data from wttr.in",
        command: "printf 'sunny 28C'",
        source: "llm_intent",
      })
      expect(activityEvents[1]?.data.activity).toHaveLength(1)
      expect(rawCall?.data.input.command).toBe("printf 'sunny 28C'")
      expect(rawCall?.data.input._activity.title).toBe("Checking Wuhan weather")
      expect(events.filter((event) => event.event === "run_status").map((event) => event.data.status)).toEqual(["queued", "running", "idle"])
      expect(events.some((event) => event.event === "todo_updated")).toBe(false)
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("restores intent activity as terminal instead of stale running", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-activity-stale-intent-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({
          id: "session_stale_activity",
          cwd: join(root, "workspace/session_stale_activity"),
          title: "Stale activity",
          metadata: {
            workspaceDir: "workspace/session_stale_activity",
            activity: [{
              id: "act_stale",
              kind: "search",
              status: "running",
              title: "Checking Wuhan weather",
              source: "llm_intent",
            }],
          },
        })
      } finally {
        await built.close()
      }

      const detail = await json(await ui.fetch("http://127.0.0.1/api/sessions/session_stale_activity", {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(detail.data.activity).toEqual([expect.objectContaining({
        id: "act_stale",
        status: "cancelled",
        title: "Checking Wuhan weather",
        source: "llm_intent",
      })])
    } finally {
      await ui.close()
    }
  })

  test("falls back to conservative activity for unknown tool results", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-activity-unknown-"))
    const llm = await createFakeLLMServer()
    llm.tool("does_not_exist", { value: 1 })
    llm.text("FINAL: unknown handled")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "use unknown", permissionMode: "acceptEdits" }),
      })
      const body = await json(response)
      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${body.data.sessionId}`, {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(detail.data.activity).toContainEqual(expect.objectContaining({
        kind: "tool",
        status: "error",
        title: "Used tool: does_not_exist",
        toolName: "does_not_exist",
      }))
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("restores and limits persisted semantic activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-activity-restore-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({
          id: "session_activity",
          cwd: join(root, "workspace/session_activity"),
          title: "Activity",
          metadata: {
            workspaceDir: "workspace/session_activity",
            activity: Array.from({ length: 105 }, (_, index) => ({
              id: `act_${index}`,
              kind: "tool",
              status: "success",
              title: `Tool ${index}`,
            })),
          },
        })
      } finally {
        await built.close()
      }

      const detail = await json(await ui.fetch("http://127.0.0.1/api/sessions/session_activity", {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(detail.data.activity).toHaveLength(100)
      expect(detail.data.activity[0].id).toBe("act_5")
      expect(detail.data.activity.at(-1)).toMatchObject({ id: "act_104", title: "Tool 104" })
    } finally {
      await ui.close()
    }
  })

  test("uploads, lists, and previews session workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-files-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({
          id: "session_files",
          cwd: join(root, "workspace/session_files"),
          title: "Files",
          metadata: { workspaceDir: "workspace/session_files" },
        })
      } finally {
        await built.close()
      }

      const form = new FormData()
      form.append("files", new File(["hello upload"], "notes.md", { type: "text/markdown" }))
      const upload = await ui.fetch("http://127.0.0.1/api/sessions/session_files/uploads", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: form,
      })
      const uploaded = await json(upload)
      const listed = await json(await ui.fetch("http://127.0.0.1/api/sessions/session_files/files", {
        headers: { authorization: "Bearer test-token" },
      }))
      const preview = await json(await ui.fetch("http://127.0.0.1/api/sessions/session_files/files/content?path=uploads%2Fnotes.md", {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(upload.status).toBe(200)
      expect(uploaded.data.files).toContainEqual(expect.objectContaining({ path: "uploads/notes.md", kind: "text" }))
      expect(listed.data.files).toContainEqual(expect.objectContaining({ path: "uploads/notes.md" }))
      expect(preview.data.content).toBe("hello upload")
    } finally {
      await ui.close()
    }
  })

  test("normalizes stale active session finish status on restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-stale-status-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({
          id: "session_stale",
          cwd: join(root, "workspace/session_stale"),
          title: "Stale status",
          metadata: { workspaceDir: "workspace/session_stale", finishStatus: "waiting_permission" },
        })
      } finally {
        await built.close()
      }

      const detail = await json(await ui.fetch("http://127.0.0.1/api/sessions/session_stale", {
        headers: { authorization: "Bearer test-token" },
      }))
      const listed = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(detail.data.session.finishStatus).toBe("idle")
      expect(listed.data.sessions.find((session: any) => session.id === "session_stale").finishStatus).toBe("idle")
    } finally {
      await ui.close()
    }
  })

  test("rejects uploads when the session upload total is too large", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-upload-total-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await mkdir(join(root, "workspace/session_big/uploads"), { recursive: true })
        await writeFile(join(root, "workspace/session_big/uploads/existing.bin"), new Uint8Array(99 * 1024 * 1024))
        await built.sessions.create({
          id: "session_big",
          cwd: join(root, "workspace/session_big"),
          title: "Big uploads",
          metadata: { workspaceDir: "workspace/session_big" },
        })
      } finally {
        await built.close()
      }

      const form = new FormData()
      form.append("files", new File([new Uint8Array(2 * 1024 * 1024)], "too-much.bin"))
      const response = await ui.fetch("http://127.0.0.1/api/sessions/session_big/uploads", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: form,
      })
      const body = await json(response)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ ok: false, code: "UPLOAD_TOO_LARGE" })
    } finally {
      await ui.close()
    }
  })

  test("rejects file preview path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-file-escape-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({
          id: "session_escape",
          cwd: join(root, "workspace/session_escape"),
          title: "Escape",
        })
      } finally {
        await built.close()
      }

      const response = await ui.fetch("http://127.0.0.1/api/sessions/session_escape/files/content?path=..%2Fsecret.txt", {
        headers: { authorization: "Bearer test-token" },
      })
      const body = await json(response)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ ok: false })
      expect(body.message).toContain("Path escapes workspace")
    } finally {
      await ui.close()
    }
  })

  test("streams permission requests and resumes after approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-permission-"))
    const llm = await createFakeLLMServer()
    llm.tool("shell", { command: "printf permission-ok" })
    llm.text("FINAL: shell approved")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const start = await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "run shell", permissionMode: "default" }),
      })
      const started = await json(start)
      const stream = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/events?token=test-token`)
      const partial = await readUntil(stream, "event: permission_request")
      const permissionId = partial.text.match(/"id":"(perm_[^"]+)"/)?.[1]
      expect(permissionId).toStartWith("perm_")
      expect(partial.text).toContain("waiting_for_permission")

      const approval = await ui.fetch(`http://127.0.0.1/api/permissions/${permissionId}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "allow", scope: "once" }),
      })
      const all = await partial.rest
      const statuses = [...all.matchAll(/event: run_status\ndata: ([^\n]+)/g)].map((match) => JSON.parse(match[1]!).status)

      expect(approval.status).toBe(200)
      expect(statuses).toEqual(expect.arrayContaining(["queued", "running", "waiting_for_permission", "idle"]))
      expect(statuses.indexOf("waiting_for_permission")).toBeLessThan(statuses.lastIndexOf("running"))
      expect(all).toContain("permission_result")
      expect(all).toContain("activity_updated")
      expect(all).toContain("Waiting for permission")
      expect(all).toContain("Permission approved")
      expect(all).toContain('"status":"running"')
      expect(all).toContain("shell approved")
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("rejects invalid permission API input", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-permission-invalid-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/permissions/perm_missing", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "maybe", scope: "forever" }),
      })
      const body = await json(response)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ ok: false, code: "UI_PERMISSION_INVALID" })
    } finally {
      await ui.close()
    }
  })

  test("allows similar permission requests for the current UI session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-permission-similar-"))
    const llm = await createFakeLLMServer()
    llm.tool("shell", { command: "printf permission-ok" })
    llm.tool("shell", { command: "printf permission-ok" })
    llm.text("FINAL: shell approved")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const created = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "Similar permissions" }),
      }))
      const sessionId = created.data.session.id
      const start = await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "run shell twice", sessionId, permissionMode: "default" }),
      })
      const started = await json(start)
      const stream = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/events?token=test-token`)
      const partial = await readUntil(stream, "event: permission_request")
      const permissionId = partial.text.match(/"id":"(perm_[^"]+)"/)?.[1]
      expect(permissionId).toStartWith("perm_")

      const approval = await ui.fetch(`http://127.0.0.1/api/permissions/${permissionId}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "allow", scope: "sessionSimilar" }),
      })
      const all = await partial.rest

      expect(approval.status).toBe(200)
      expect(all).toContain("shell approved")
      expect((all.match(/^event: permission_request$/gm) ?? []).length).toBe(1)
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("redacts common secrets from run streams and wait responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-redact-run-"))
    const llm = await createFakeLLMServer()
    llm.tool("shell", { command: "printf 'API_KEY=sk-12345678901234567890'" })
    llm.text("FINAL: done")
    await writeFile(
      join(root, "pixiu.jsonc"),
      JSON.stringify({
        model: "fake/model",
        providers: {
          "openai-compatible": {
            baseURL: llm.url,
            apiKey: "sk-test",
            model: "fake/model",
          },
        },
      }),
      "utf8",
    )
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "run secret shell", permissionMode: "bypassPermissions" }),
      })
      const text = await response.text()
      const body = JSON.parse(text)

      expect(response.status).toBe(200)
      expect(text).not.toContain("sk-12345678901234567890")
      expect(JSON.stringify(body.data.events)).toContain("[redacted]")
    } finally {
      await ui.close()
      await llm.close()
    }
  })
})

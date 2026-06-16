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
  while (!text.includes(pattern)) {
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
      expect(listed.data.sessions[0]).toMatchObject({ model: "fake/model", finishStatus: "done" })
      expect(llm.calls()).toBe(1)
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

      expect(start.status).toBe(200)
      expect(events.some((event) => event.event === "agent_event" && event.data.type === "llm_text_delta")).toBe(true)
      expect(events.at(-1)).toMatchObject({
        event: "result",
        data: expect.objectContaining({ answer: "streamed hello", status: "done" }),
      })
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

      expect(result.data.status).toBe("done")
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
      expect(detail.data.evidence.artifacts).toContainEqual(expect.objectContaining({ tool: "write", path: "report.md" }))
      expect(preview.data.content).toContain("# Report")
    } finally {
      await ui.close()
      await llm.close()
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
      const partial = await readUntil(stream, "permission_request")
      const permissionId = partial.text.match(/"id":"(perm_[^"]+)"/)?.[1]
      expect(permissionId).toStartWith("perm_")
      expect(partial.text).toContain("waiting_permission")

      const approval = await ui.fetch(`http://127.0.0.1/api/permissions/${permissionId}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "allow", scope: "once" }),
      })
      const all = await partial.rest

      expect(approval.status).toBe(200)
      expect(all).toContain("permission_result")
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
      const partial = await readUntil(stream, "permission_request")
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
      expect((all.match(/permission_request/g) ?? []).length).toBe(1)
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

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { createUiServer } from "../../src/ui/server/server"
import { createFakeLLMServer } from "../harness/llm-server"

async function json(response: Response) {
  return await response.json() as any
}

async function runGit(root: string, ...args: string[]) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
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

  test("creates an empty chat session with an external isolated workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-create-session-"))
    const external = await mkdtemp(join(tmpdir(), "pixiu-ui-create-session-external-"))
    await mkdir(join(root, "workspace/session_legacy/.venv/bin"), { recursive: true })
    await writeFile(join(external, "python"), "external interpreter\n", "utf8")
    await symlink(join(external, "python"), join(root, "workspace/session_legacy/.venv/bin/python"))
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
        workspaceDir: expect.any(String),
      })
      expect(body.data.session.id).toStartWith("session_")
      expect(body.data.session.cwd.startsWith(root)).toBe(false)
      expect(body.data.session.cwd.endsWith("/work")).toBe(true)
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

      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}`, {
        headers: { authorization: "Bearer test-token" },
      }))
      const assistants = detail.data.messages.filter((message: any) => message.role === "assistant")
      expect(assistants.length).toBe(1)
      expect(assistants[0].parts.some((part: any) => part.type === "tool_call")).toBe(false)
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("finishes a web run while waiting for required user action", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-user-action-"))
    const llm = await createFakeLLMServer()
    llm.tool("request_user_action", {
      title: "请完成小红书登录",
      reason: "浏览器页面需要用户登录后才能继续。",
      category: "auth",
      instructions: ["在已打开的浏览器中完成登录。", "回到 Pixiu 后回复继续。"],
      resumeHint: "完成登录后回复继续。",
    })
    await writeFile(join(root, "pixiu.jsonc"), JSON.stringify({
      model: "fake/model",
      providers: {
        "openai-compatible": { baseURL: llm.url, apiKey: "sk-test", model: "fake/model" },
      },
    }), "utf8")
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "查看小红书", permissionMode: "acceptEdits" }),
      })
      const body = await json(response)

      expect(response.status).toBe(200)
      expect(body.data).toMatchObject({ status: "idle", finishReason: "user_action_required" })
      expect(body.data.answer).toContain("请完成小红书登录")
      expect(body.data.answer).toContain("完成登录后回复继续")
      expect(llm.calls()).toBe(1)
      const existing = await json(await ui.fetch(`http://127.0.0.1/api/runs/${body.data.runId}`, {
        headers: { authorization: "Bearer test-token" },
      }))
      const missing = await json(await ui.fetch("http://127.0.0.1/api/runs/run_missing", {
        headers: { authorization: "Bearer test-token" },
      }))
      expect(existing.data).toEqual({ found: true, status: "idle" })
      expect(missing.data).toEqual({ found: false })
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("persists per-turn usage and retries with a different model", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-turn-retry-"))
    const llm = await createFakeLLMServer()
    llm.text("FINAL: first", { usage: { input: 120, output: 9 } })
    llm.text("FINAL: second", { usage: { input: 150, output: 12 } })
    await writeFile(join(root, "pixiu.jsonc"), JSON.stringify({
      model: "first/model",
      providers: {
        "openai-compatible": { baseURL: llm.url, apiKey: "sk-test", model: "first/model" },
      },
    }), "utf8")
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const created = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "Retry metrics" }),
      }))
      const sessionId = created.data.session.id
      const first = await json(await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "try", sessionId, permissionMode: "acceptEdits" }),
      }))
      const second = await json(await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          message: "try",
          sessionId,
          permissionMode: "acceptEdits",
          model: "second/model",
          retryOf: first.data.turnId,
        }),
      }))
      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}`, {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(first.data).toMatchObject({ model: "first/model", inputTokens: 120, outputTokens: 9, retryCount: 0 })
      expect(second.data).toMatchObject({
        model: "second/model",
        inputTokens: 150,
        outputTokens: 12,
        retryCount: 1,
        retryOf: first.data.turnId,
      })
      expect(detail.data.turns).toEqual([
        expect.objectContaining({ id: first.data.turnId, model: "first/model", inputTokens: 120, outputTokens: 9, retryCount: 0 }),
        expect.objectContaining({ id: second.data.turnId, model: "second/model", retryOf: first.data.turnId, retryCount: 1 }),
      ])
      expect((llm.inputs()[1] as any).model).toBe("second/model")
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("session in a project with a local rootPath uses an isolated copy of that folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-root-"))
    const workdir = await mkdtemp(join(tmpdir(), "pixiu-ui-workdir-"))
    await writeFile(join(workdir, "existing.txt"), "from project", "utf8")
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const project = await json(await ui.fetch("http://127.0.0.1/api/projects", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ name: "Local", rootPath: workdir }),
      }))
      const session = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "in folder", projectId: project.data.project.id }),
      }))
      expect(resolve(session.data.session.cwd)).not.toBe(resolve(workdir))
      expect(session.data.session.cwd.endsWith("/work")).toBe(true)
      expect(await readFile(join(session.data.session.cwd, "existing.txt"), "utf8")).toBe("from project")
    } finally {
      await ui.close()
    }
  })

  test("a rooted project receives agent changes only after review and apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-root2-"))
    const workdir = await mkdtemp(join(tmpdir(), "pixiu-ui-workdir2-"))
    const llm = await createFakeLLMServer()
    llm.tool("write", { path: "note.md", content: "# hello real folder" })
    llm.text("FINAL: wrote note")
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
      const project = await json(await ui.fetch("http://127.0.0.1/api/projects", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ name: "Local", rootPath: workdir }),
      }))
      const session = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "write", projectId: project.data.project.id }),
      }))
      const run = await json(await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "write a note", sessionId: session.data.session.id, permissionMode: "acceptEdits" }),
      }))
      expect(run.data.answer).toBe("wrote note")
      expect(await Bun.file(join(workdir, "note.md")).exists()).toBe(false)
      expect(await readFile(join(session.data.session.cwd, "note.md"), "utf8")).toBe("# hello real folder")

      const changes = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${session.data.session.id}/changes`, {
        headers: { authorization: "Bearer test-token" },
      }))
      const applied = await ui.fetch(`http://127.0.0.1/api/sessions/${session.data.session.id}/changes/apply`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ revision: changes.data.revision, selections: [{ path: "note.md" }] }),
      })
      expect(applied.status).toBe(200)
      expect(await readFile(join(workdir, "note.md"), "utf8")).toBe("# hello real folder")
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("resumes SSE after the last received event id without replay duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-sse-cursor-"))
    const llm = await createFakeLLMServer()
    llm.text("FINAL: cursor")
    await writeFile(join(root, "pixiu.jsonc"), JSON.stringify({
      model: "fake/model",
      providers: { "openai-compatible": { baseURL: llm.url, apiKey: "sk-test", model: "fake/model" } },
    }), "utf8")
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const run = await json(await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "cursor", permissionMode: "acceptEdits" }),
      }))
      const first = await (await ui.fetch(`http://127.0.0.1/api/runs/${run.data.runId}/events?token=test-token`)).text()
      const ids = [...first.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))
      const cursor = ids.at(-2)
      expect(cursor).toBeDefined()
      const resumed = await (await ui.fetch(`http://127.0.0.1/api/runs/${run.data.runId}/events?token=test-token`, {
        headers: { "last-event-id": String(cursor) },
      })).text()

      expect((resumed.match(/^id: /gm) ?? [])).toHaveLength(1)
      expect(resumed).toContain("event: result")
      expect(resumed).not.toContain("event: agent_event")
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("rejects a project rootPath that is not an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-badroot-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/projects", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ name: "Bad", rootPath: join(root, "does-not-exist") }),
      })
      const body = await json(response)
      expect(response.status).toBe(400)
      expect(body.code).toBe("PROJECT_ROOT_INVALID")
    } finally {
      await ui.close()
    }
  })

  test("default project sessions still use the sandbox workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-default-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const session = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "default" }),
      }))
      expect(session.data.session.cwd).toContain("workspace")
      expect(resolve(session.data.session.cwd)).not.toBe(resolve(root))
    } finally {
      await ui.close()
    }
  })

  test("lists subdirectories for the folder picker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-fs-"))
    await mkdir(join(root, "alpha"))
    await mkdir(join(root, "beta"))
    await writeFile(join(root, "note.txt"), "x", "utf8")
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const body = await json(await ui.fetch(`http://127.0.0.1/api/fs/list?path=${encodeURIComponent(root)}&token=test-token`, {
        headers: { authorization: "Bearer test-token" },
      }))
      expect(body.ok).toBe(true)
      const names = body.data.entries.map((entry: any) => entry.name)
      expect(names).toEqual(["alpha", "beta"]) // directories only, sorted; note.txt excluded
      expect(resolve(body.data.path)).toBe(resolve(root))
      expect(typeof body.data.parent).toBe("string")
      expect(typeof body.data.home).toBe("string")
    } finally {
      await ui.close()
    }
  })

  test("rejects a fs/list path that is a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-fsfile-"))
    await writeFile(join(root, "note.txt"), "x", "utf8")
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch(`http://127.0.0.1/api/fs/list?path=${encodeURIComponent(join(root, "note.txt"))}&token=test-token`, {
        headers: { authorization: "Bearer test-token" },
      })
      const body = await json(response)
      expect(response.status).toBe(400)
      expect(body.code).toBe("FS_PATH_INVALID")
    } finally {
      await ui.close()
    }
  })

  test("fs/list defaults to the home directory when no path is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-fshome-"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const body = await json(await ui.fetch("http://127.0.0.1/api/fs/list?token=test-token", {
        headers: { authorization: "Bearer test-token" },
      }))
      expect(body.ok).toBe(true)
      expect(resolve(body.data.path)).toBe(resolve(body.data.home))
    } finally {
      await ui.close()
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
      const persistedSessionId = body.data.sessionId
      const persistedTurnId = body.data.turnId
      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${body.data.sessionId}`, {
        headers: { authorization: "Bearer test-token" },
      }))
      const preview = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${body.data.sessionId}/files/content?path=report.md`, {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(response.status).toBe(200)
      expect(body.data.answer).toBe("wrote report")
      expect(body.data).toMatchObject({
        turnId: expect.any(String),
        model: "fake/model",
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        durationMs: expect.any(Number),
        retryCount: 0,
      })
      expect(detail.data.turns).toContainEqual(expect.objectContaining({
        id: body.data.turnId,
        runId: body.data.runId,
        sessionId: body.data.sessionId,
        model: "fake/model",
        status: "idle",
        durationMs: expect.any(Number),
      }))
      expect(detail.data.messages.length).toBeGreaterThan(1)
      expect(detail.data.messages.map((message: any) => message.turnId)).toEqual(
        detail.data.messages.map(() => body.data.turnId),
      )
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

      const rollbackResponse = await ui.fetch(
        `http://127.0.0.1/api/sessions/${persistedSessionId}/turns/${persistedTurnId}/rollback`,
        { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: "{}" },
      )
      const rollback = await json(rollbackResponse)
      expect(rollback).toEqual(expect.objectContaining({ ok: true }))
      expect(rollbackResponse.status).toBe(200)
      expect(rollback.data).toMatchObject({
        turnId: persistedTurnId,
        checkpointId: expect.any(String),
        changes: { available: true, changes: [] },
      })
      expect(await Bun.file(join(detail.data.session.cwd, "report.md")).exists()).toBe(false)
    } finally {
      await ui.close()
      await llm.close()
    }
  })

  test("resolves validated line references into turn-scoped model context", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-file-reference-"))
    const llm = await createFakeLLMServer()
    llm.text("FINAL: reviewed range")
    await writeFile(join(root, "pixiu.jsonc"), JSON.stringify({
      model: "fake/model",
      providers: {
        "openai-compatible": { baseURL: llm.url, apiKey: "sk-test", model: "fake/model" },
      },
    }), "utf8")
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const created = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "References" }),
      }))
      const sessionId = created.data.session.id
      await mkdir(join(created.data.session.cwd, "src"), { recursive: true })
      await writeFile(join(created.data.session.cwd, "src/example.ts"), [
        "const one = 1",
        "const two = 2",
        "const three = 3",
        "const four = 4",
      ].join("\n"), "utf8")

      const result = await json(await ui.fetch("http://127.0.0.1/api/runs?wait=1", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          message: "Review this",
          sessionId,
          permissionMode: "acceptEdits",
          references: [{ path: "src/example.ts", source: "workspace", startLine: 2, endLine: 3 }],
        }),
      }))
      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}`, {
        headers: { authorization: "Bearer test-token" },
      }))
      const modelMessages = llm.inputs()[0]?.messages as Array<{ role: string; content: string }>
      const modelUser = modelMessages.slice().reverse().find((message) => message.role === "user")?.content ?? ""

      expect(result.data.status).toBe("idle")
      expect(modelUser).toContain("[Referenced file: @src/example.ts:2-3]")
      expect(modelUser).toContain("const two = 2\nconst three = 3")
      expect(modelUser).not.toContain("const one = 1")
      expect(modelUser).not.toContain("const four = 4")
      expect(detail.data.messages[0]).toMatchObject({
        turnId: result.data.turnId,
        parts: [
          { type: "text", text: "Review this" },
          {
            type: "file_reference",
            path: "src/example.ts",
            source: "workspace",
            startLine: 2,
            endLine: 3,
            content: "const two = 2\nconst three = 3",
          },
        ],
      })
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
      await writeFile(join(created.data.session.cwd, "note.txt"), "hello activity", "utf8")
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

  test("returns a project file tree with branch and structured Git changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-workspace-git-"))
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, ".tools/bun/bin"), { recursive: true })
    await mkdir(join(root, ".venv/bin"), { recursive: true })
    await mkdir(join(root, "workspace/session_old"), { recursive: true })
    await writeFile(join(root, "src/main.ts"), "export const value = 1\n", "utf8")
    await writeFile(join(root, "README.md"), "initial\n", "utf8")
    await writeFile(join(root, ".tools/bun/bin/bunx"), "local tool cache\n", "utf8")
    await writeFile(join(root, ".venv/bin/python"), "local virtual environment\n", "utf8")
    await writeFile(join(root, "workspace/session_old/result.txt"), "legacy session\n", "utf8")
    await runGit(root, "init")
    await runGit(root, "checkout", "-b", "main")
    await runGit(root, "add", "README.md", "src/main.ts")
    await runGit(root, "-c", "user.name=Pixiu Test", "-c", "user.email=pixiu@example.test", "commit", "-m", "initial")
    await runGit(root, "mv", "README.md", "GUIDE.md")
    await writeFile(join(root, "src/main.ts"), "export const value = 2\n", "utf8")
    await writeFile(join(root, "new file.md"), "untracked\n", "utf8")

    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const response = await ui.fetch("http://127.0.0.1/api/workspace", {
        headers: { authorization: "Bearer test-token" },
      })
      const body = await json(response)
      const changes = new Map(body.data.git.changedFiles.map((file: any) => [file.path, file]))

      expect(response.status).toBe(200)
      expect(body.data).toMatchObject({
        available: true,
        projectId: "project_default",
        rootPath: root,
        truncated: false,
        git: { available: true, branch: "main" },
      })
      expect(body.data.entries).toContainEqual(expect.objectContaining({
        path: "src",
        parentPath: ".",
        type: "directory",
      }))
      expect(body.data.entries).toContainEqual(expect.objectContaining({
        path: "src/main.ts",
        parentPath: "src",
        type: "file",
        kind: "text",
        gitStatus: "modified",
      }))
      expect(body.data.entries.some((entry: any) => entry.path === ".tools" || entry.path.startsWith(".tools/"))).toBe(false)
      expect(body.data.entries.some((entry: any) => entry.path === ".venv" || entry.path.startsWith(".venv/"))).toBe(false)
      expect(body.data.entries.some((entry: any) => entry.path === "workspace" || entry.path.startsWith("workspace/"))).toBe(false)
      expect(body.data.git.changedFiles.some((file: any) => file.path === "workspace" || file.path.startsWith("workspace/"))).toBe(false)
      expect(changes.get("src/main.ts")).toMatchObject({ status: "modified", indexStatus: " ", workingTreeStatus: "M" })
      expect(changes.get("new file.md")).toMatchObject({ status: "untracked", indexStatus: "?", workingTreeStatus: "?" })
      expect(changes.get("GUIDE.md")).toMatchObject({ status: "renamed", originalPath: "README.md", indexStatus: "R" })
    } finally {
      await ui.close()
    }
  })

  test("returns revisioned session changes from the isolated work copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-session-changes-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src/main.ts"), "one\ntwo\nthree\n", "utf8")
    await writeFile(join(root, "pwd"), "must-not-copy", { mode: 0o600 })
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const created = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ title: "Review changes" }),
      }))
      const session = created.data.session
      await writeFile(join(session.cwd, "src/main.ts"), "one\nTWO\nthree\n", "utf8")
      await writeFile(join(session.cwd, "src/new.ts"), "export const added = true\n", "utf8")

      const changes = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${session.id}/changes`, {
        headers: { authorization: "Bearer test-token" },
      }))
      const diff = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${session.id}/changes/diff?path=${encodeURIComponent("src/main.ts")}`, {
        headers: { authorization: "Bearer test-token" },
      }))

      expect(changes.data).toMatchObject({
        available: true,
        sessionId: session.id,
        projectRoot: root,
        revision: expect.any(String),
        baseRevision: expect.any(String),
        workRevision: expect.any(String),
        changes: expect.arrayContaining([
          expect.objectContaining({ path: "src/main.ts", status: "modified", hunkCount: 1, additions: 1, deletions: 1 }),
          expect.objectContaining({ path: "src/new.ts", status: "added", additions: 1 }),
        ]),
      })
      expect(diff.data).toMatchObject({
        available: true,
        path: "src/main.ts",
        revision: changes.data.revision,
        hunks: [expect.objectContaining({ id: expect.any(String), oldStart: 1, newStart: 1 })],
      })
      expect(diff.data.content).toContain("-two\n+TWO")
      expect(await readFile(join(root, "src/main.ts"), "utf8")).toBe("one\ntwo\nthree\n")
      expect(await Bun.file(join(session.cwd, "pwd")).exists()).toBe(false)
    } finally {
      await ui.close()
    }
  })

  test("applies and discards selected hunks, stages and commits files, and undoes the last apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-change-actions-"))
    const original = ["alpha", "keep-a", "keep-b", "keep-c", "keep-d", "keep-e", "keep-f", "keep-g", "keep-h", "omega", ""].join("\n")
    const changed = ["ALPHA", "keep-a", "keep-b", "keep-c", "keep-d", "keep-e", "keep-f", "keep-g", "keep-h", "OMEGA", ""].join("\n")
    await writeFile(join(root, "notes.txt"), original, "utf8")
    await runGit(root, "init")
    await runGit(root, "config", "user.name", "Pixiu Test")
    await runGit(root, "config", "user.email", "pixiu@example.test")
    await runGit(root, "add", "notes.txt")
    await runGit(root, "commit", "-m", "initial")

    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const headers = { authorization: "Bearer test-token", "content-type": "application/json" }
      const created = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Change actions" }),
      }))
      const sessionId = created.data.session.id as string
      const workRoot = created.data.session.cwd as string
      await writeFile(join(workRoot, "notes.txt"), changed, "utf8")

      const initialChanges = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes`, { headers }))
      const initialRevision = initialChanges.data.revision as string
      const diff = await json(await ui.fetch(
        `http://127.0.0.1/api/sessions/${sessionId}/changes/diff?path=notes.txt`,
        { headers },
      ))
      expect(diff.data.hunks).toHaveLength(2)
      const firstHunkId = diff.data.hunks[0].id as string
      const secondHunkId = diff.data.hunks[1].id as string

      const appliedResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision, selections: [{ path: "notes.txt", hunkIds: [firstHunkId] }] }),
      })
      const applied = await json(appliedResponse)
      expect(appliedResponse.status).toBe(200)
      expect(applied.data.operation).toMatchObject({ action: "apply", paths: ["notes.txt"] })
      expect(applied.data.changes).toMatchObject({ canUndo: true })
      expect(applied.data.changes.changes[0]).toMatchObject({ applied: true, appliedHunkIds: [firstHunkId], staged: false })
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe(changed.replace("OMEGA", "omega"))

      const unappliedStageResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/stage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision, selections: [{ path: "notes.txt", hunkIds: [secondHunkId] }] }),
      })
      expect(unappliedStageResponse.status).toBe(409)
      expect(await json(unappliedStageResponse)).toMatchObject({ ok: false, code: "WORKSPACE_CHANGE_NOT_APPLIED" })

      const stagedResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/stage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision, selections: [{ path: "notes.txt", hunkIds: [firstHunkId] }] }),
      })
      const staged = await json(stagedResponse)
      expect(stagedResponse.status).toBe(200)
      expect(staged.data.operation).toMatchObject({
        action: "stage",
        paths: ["notes.txt"],
        selections: [{ path: "notes.txt", hunkIds: [firstHunkId] }],
      })
      expect(staged.data.changes.changes[0]).toMatchObject({ staged: true, committed: false })
      expect(await runGit(root, "show", ":notes.txt")).toBe(changed.replace("OMEGA", "omega"))

      const unstagedResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/unstage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision, selections: [{ path: "notes.txt", hunkIds: [firstHunkId] }] }),
      })
      const unstaged = await json(unstagedResponse)
      expect(unstagedResponse.status).toBe(200)
      expect(unstaged.data.operation).toMatchObject({
        action: "unstage",
        selections: [{ path: "notes.txt", hunkIds: [firstHunkId] }],
      })
      expect(await runGit(root, "show", ":notes.txt")).toBe(original)

      const restagedResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/stage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision, selections: [{ path: "notes.txt", hunkIds: [firstHunkId] }] }),
      })
      expect(restagedResponse.status).toBe(200)

      const committedResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/commit`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision, message: "Apply first Pixiu hunk" }),
      })
      const committed = await json(committedResponse)
      expect(committedResponse.status).toBe(200)
      expect(committed.data.operation).toMatchObject({ action: "commit", commit: expect.any(String) })
      expect(committed.data.changes.changes[0]).toMatchObject({ staged: false, committed: true })
      expect(await runGit(root, "show", "HEAD:notes.txt")).toBe(changed.replace("OMEGA", "omega"))

      const undoneResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/undo`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision }),
      })
      const undone = await json(undoneResponse)
      expect(undoneResponse.status).toBe(200)
      expect(undone.data.operation).toMatchObject({ action: "undo", paths: ["notes.txt"] })
      expect(undone.data.changes).toMatchObject({ canUndo: false })
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe(original)

      const discardedResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/discard`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision, selections: [{ path: "notes.txt", hunkIds: [secondHunkId] }] }),
      })
      const discarded = await json(discardedResponse)
      expect(discardedResponse.status).toBe(200)
      expect(discarded.data.operation).toMatchObject({ action: "discard", paths: ["notes.txt"] })
      expect(await readFile(join(workRoot, "notes.txt"), "utf8")).toBe(changed.replace("OMEGA", "omega"))

      const staleResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: initialRevision, selections: [{ path: "notes.txt" }] }),
      })
      const stale = await json(staleResponse)
      expect(staleResponse.status).toBe(409)
      expect(stale).toMatchObject({ ok: false, code: "WORKSPACE_CHANGE_STALE" })
    } finally {
      await ui.close()
    }
  })

  test("runs preset and confirmed custom validations bound to a real turn and current revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-validations-"))
    await writeFile(join(root, "pixiu.jsonc"), JSON.stringify({
      project: { commands: { test: "test -f marker.txt && printf validation-ok" } },
    }), "utf8")
    await writeFile(join(root, "marker.txt"), "ready\n", "utf8")
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const headers = { authorization: "Bearer test-token", "content-type": "application/json" }
      const created = await json(await ui.fetch("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Validation binding" }),
      }))
      const sessionId = created.data.session.id as string
      const turnId = "turn_validation"
      const runtimeModule = await import("../../src/runtime/build")
      const runtime = await runtimeModule.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await runtime.sessions.createTurn({
          id: turnId,
          runId: "run_validation",
          sessionId,
          model: "fake/model",
          status: "idle",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 1,
          retryCount: 0,
        })
      } finally {
        await runtime.close()
      }

      const changes = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/changes`, { headers }))
      const revision = changes.data.revision as string
      const presetResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/validations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ turnId, kind: "test" }),
      })
      const preset = await json(presetResponse)
      expect(presetResponse.status).toBe(200)
      expect(preset.data.record).toMatchObject({
        sessionId,
        turnId,
        revision,
        kind: "test",
        command: "test -f marker.txt && printf validation-ok",
        status: "passed",
        timedOut: false,
      })
      expect(preset.data.record.output).toContain("validation-ok")

      const unconfirmedResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/validations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ turnId, kind: "custom", command: "exit 3" }),
      })
      const unconfirmed = await json(unconfirmedResponse)
      expect(unconfirmedResponse.status).toBe(400)
      expect(unconfirmed).toMatchObject({ ok: false, code: "WORKSPACE_VALIDATION_CONFIRMATION_REQUIRED" })

      const customResponse = await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}/validations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ turnId, kind: "custom", command: "printf custom-failed; exit 3", confirmed: true }),
      })
      const custom = await json(customResponse)
      expect(customResponse.status).toBe(200)
      expect(custom.data.record).toMatchObject({ turnId, revision, kind: "custom", status: "failed", exitCode: 3 })
      expect(custom.data.record.output).toContain("custom-failed")

      const detail = await json(await ui.fetch(`http://127.0.0.1/api/sessions/${sessionId}`, { headers }))
      expect(detail.data.validations).toHaveLength(2)
      expect(detail.data.validations.map((record: any) => record.turnId)).toEqual([turnId, turnId])
      expect(detail.data.validations.map((record: any) => record.revision)).toEqual([revision, revision])
    } finally {
      await ui.close()
    }
  })

  test("previews and diffs project files without interpreting paths as commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-workspace-diff-"))
    await writeFile(join(root, "tracked.ts"), "const value = 1\n", "utf8")
    await writeFile(join(root, "deleted.ts"), "const deleted = true\n", "utf8")
    await runGit(root, "init")
    await runGit(root, "add", "tracked.ts", "deleted.ts")
    await runGit(root, "-c", "user.name=Pixiu Test", "-c", "user.email=pixiu@example.test", "commit", "-m", "initial")
    await runGit(root, "rm", "deleted.ts")
    await writeFile(join(root, "tracked.ts"), "const value = 2\n", "utf8")
    await writeFile(join(root, "odd;name.ts"), "const odd = true\n", "utf8")
    await writeFile(join(root, ":(glob)*.ts"), "const literal = true\n", "utf8")

    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const headers = { authorization: "Bearer test-token" }
      const preview = await json(await ui.fetch("http://127.0.0.1/api/workspace/content?path=tracked.ts", { headers }))
      const diff = await json(await ui.fetch("http://127.0.0.1/api/workspace/diff?path=tracked.ts", { headers }))
      const oddDiff = await json(await ui.fetch(`http://127.0.0.1/api/workspace/diff?path=${encodeURIComponent("odd;name.ts")}`, { headers }))
      const literalDiff = await json(await ui.fetch(`http://127.0.0.1/api/workspace/diff?path=${encodeURIComponent(":(glob)*.ts")}`, { headers }))
      const deletedDiff = await json(await ui.fetch("http://127.0.0.1/api/workspace/diff?path=deleted.ts", { headers }))

      expect(preview.data).toMatchObject({ path: "tracked.ts", content: "const value = 2\n" })
      expect(diff.data).toMatchObject({ path: "tracked.ts", available: true, status: "modified" })
      expect(diff.data.content).toContain("-const value = 1")
      expect(diff.data.content).toContain("+const value = 2")
      expect(oddDiff.data).toMatchObject({ path: "odd;name.ts", available: true, status: "untracked" })
      expect(oddDiff.data.content).toContain("+const odd = true")
      expect(literalDiff.data).toMatchObject({ path: ":(glob)*.ts", available: true, status: "untracked" })
      expect(literalDiff.data.content).toContain("+const literal = true")
      expect(deletedDiff.data).toMatchObject({ path: "deleted.ts", available: true, status: "deleted" })
      expect(deletedDiff.data.content).toContain("-const deleted = true")
    } finally {
      await ui.close()
    }
  })

  test("degrades outside Git and rejects traversal and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-workspace-plain-"))
    const outside = await mkdtemp(join(tmpdir(), "pixiu-ui-workspace-outside-"))
    await writeFile(join(root, "note.txt"), "plain workspace\n", "utf8")
    await writeFile(join(outside, "outside.txt"), "outside\n", "utf8")
    await symlink(join(outside, "outside.txt"), join(root, "linked.txt"))

    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const headers = { authorization: "Bearer test-token" }
      const workspace = await json(await ui.fetch("http://127.0.0.1/api/workspace", { headers }))
      const diff = await json(await ui.fetch("http://127.0.0.1/api/workspace/diff?path=note.txt", { headers }))
      const traversalResponse = await ui.fetch("http://127.0.0.1/api/workspace/content?path=..%2Foutside.txt", { headers })
      const traversal = await json(traversalResponse)
      const symlinkResponse = await ui.fetch("http://127.0.0.1/api/workspace/content?path=linked.txt", { headers })
      const symlinkBody = await json(symlinkResponse)

      expect(workspace.data.git).toMatchObject({ available: false, reason: "not_repository", changedFiles: [] })
      expect(workspace.data.entries).toContainEqual(expect.objectContaining({ path: "linked.txt", type: "symlink" }))
      expect(diff.data).toMatchObject({ available: false, reason: "not_repository", content: "" })
      expect(traversalResponse.status).toBe(400)
      expect(traversal).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" })
      expect(symlinkResponse.status).toBe(400)
      expect(symlinkBody).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" })
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

  test("rejects session file previews through symlinks outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-file-symlink-"))
    const outside = await mkdtemp(join(tmpdir(), "pixiu-ui-file-symlink-outside-"))
    const sessionRoot = join(root, "workspace/session_symlink")
    await mkdir(sessionRoot, { recursive: true })
    await writeFile(join(outside, "secret.txt"), "OUTSIDE_SENTINEL", "utf8")
    await symlink(join(outside, "secret.txt"), join(sessionRoot, "leak.txt"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({ id: "session_symlink", cwd: sessionRoot, title: "Symlink" })
      } finally {
        await built.close()
      }

      const response = await ui.fetch("http://127.0.0.1/api/sessions/session_symlink/files/content?path=leak.txt", {
        headers: { authorization: "Bearer test-token" },
      })
      const body = await json(response)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" })
      expect(JSON.stringify(body)).not.toContain("OUTSIDE_SENTINEL")
    } finally {
      await ui.close()
    }
  })

  test("rejects session uploads through symlinks outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-upload-symlink-"))
    const outside = await mkdtemp(join(tmpdir(), "pixiu-ui-upload-symlink-outside-"))
    const sessionRoot = join(root, "workspace/session_upload_symlink")
    await mkdir(sessionRoot, { recursive: true })
    await symlink(outside, join(sessionRoot, "uploads"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({ id: "session_upload_symlink", cwd: sessionRoot, title: "Upload symlink" })
      } finally {
        await built.close()
      }

      const form = new FormData()
      form.append("files", new File(["must stay inside"], "notes.md", { type: "text/markdown" }))
      const response = await ui.fetch("http://127.0.0.1/api/sessions/session_upload_symlink/uploads", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: form,
      })
      const body = await json(response)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" })
      await expect(readFile(join(outside, "notes.md"), "utf8")).rejects.toThrow()
    } finally {
      await ui.close()
    }
  })

  test("rejects an upload target that is a symlink outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-upload-target-symlink-"))
    const outside = await mkdtemp(join(tmpdir(), "pixiu-ui-upload-target-outside-"))
    const sessionRoot = join(root, "workspace/session_upload_target")
    await mkdir(join(sessionRoot, "uploads"), { recursive: true })
    const outsideFile = join(outside, "secret.md")
    await writeFile(outsideFile, "ORIGINAL_OUTSIDE_CONTENT", "utf8")
    await symlink(outsideFile, join(sessionRoot, "uploads/notes.md"))
    const ui = await createUiServer({ cwd: root, token: "test-token" })
    try {
      const runtime = await import("../../src/runtime/build")
      const built = await runtime.buildRuntime({ cwd: root, loadLLM: false })
      try {
        await built.sessions.create({ id: "session_upload_target", cwd: sessionRoot, title: "Upload target" })
      } finally {
        await built.close()
      }

      const form = new FormData()
      form.append("files", new File(["replacement"], "notes.md", { type: "text/markdown" }))
      const response = await ui.fetch("http://127.0.0.1/api/sessions/session_upload_target/uploads", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: form,
      })
      const body = await json(response)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" })
      expect(await readFile(outsideFile, "utf8")).toBe("ORIGINAL_OUTSIDE_CONTENT")
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

  test("replays pending permission requests to late SSE subscribers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-ui-permission-replay-"))
    const llm = await createFakeLLMServer()
    llm.tool("shell", { command: "printf permission-replay" })
    llm.text("FINAL: replay approved")
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
      const started = await json(await ui.fetch("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ message: "replay shell permission", permissionMode: "default" }),
      }))
      await llm.wait(1)
      await Bun.sleep(30)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1_000)
      const stream = await ui.fetch(`http://127.0.0.1/api/runs/${started.data.runId}/events?token=test-token`, {
        signal: controller.signal,
      })
      const partial = await readUntil(stream, "event: permission_request")
      clearTimeout(timeout)
      const permission = partial.text.match(/event: permission_request\ndata: ([^\n]+)/)?.[1]
      const data = permission ? JSON.parse(permission) : undefined
      const permissionId = data?.id

      expect(partial.text).toContain('"status":"waiting_for_permission"')
      expect(permissionId).toStartWith("perm_")
      expect(data).toMatchObject({
        runId: started.data.runId,
        request: { tool: "shell", input: { command: "printf permission-replay" } },
        decision: { action: "ask" },
      })
      expect(typeof data.similarityKey).toBe("string")

      const approval = await ui.fetch(`http://127.0.0.1/api/permissions/${permissionId}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "allow", scope: "once" }),
      })
      const approvalBody = await json(approval)
      expect(approval.status, JSON.stringify(approvalBody)).toBe(200)
      const all = await partial.rest

      expect(all).toContain("permission_result")
      expect(all).toContain("replay approved")
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

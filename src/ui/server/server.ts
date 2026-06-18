import { randomBytes } from "node:crypto"
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

import { approximateTokens } from "../../agent/compaction"
import {
  activityFromToolIntent,
  activityFromToolResult,
  limitActivityItems,
  normalizeActivityItems,
  normalizePersistedActivityItems,
  stableActivityId,
  updateActivityWithToolResult,
} from "../../activity/format"
import type { ActivityItem, ActivityUpdatedEvent } from "../../activity/types"
import type { PixiuConfig } from "../../config/defaults"
import { resolveProviderConfig } from "../../config/loader"
import { OpenAICompatibleClient } from "../../llm/openai"
import { buildRuntime, type Runtime, type RuntimeWithoutLLM } from "../../runtime/build"
import { formatError, PixiuError } from "../../shared/errors"
import { readJsoncFile } from "../../shared/json"
import type { JsonObject, JsonValue } from "../../shared/json"
import type { ProjectRecord, SessionMessage, SessionRecord } from "../../session/types"
import { DEFAULT_PROJECT_ID } from "../../session/projects"
import { collectSessionEvidence } from "../../session/evidence"
import { apiFailure, apiSuccess, type ApiFailure, type UiConfigResponse, type UiProjectSummary, type UiProviderSummary, type UiSessionSummary, type UiStatus } from "../shared/api"
import type { PermissionDecision, PermissionMode, PermissionRequest } from "../../permission/types"
import type { AgentEvent } from "../../agent/events"
import { PathGuard } from "../../sandbox/path"
import { createID } from "../../shared/id"
import { redactSecrets } from "../../shared/redact"
import { inspectMCPServers } from "../../mcp/status"
import type { MCPServerStatus } from "../../mcp/types"
import {
  isTerminalRunStatus,
  normalizePersistedRunStatus,
  type RunStatus,
  type RunStatusEvent,
  type RunStatusPhase,
  type TerminalRunStatus,
} from "../../run/status"

export const DEFAULT_UI_HOST = "127.0.0.1"
export const DEFAULT_UI_PORT = 2208
export const UI_VERSION = "0.0.0"
const CONFIG_FILE = "pixiu.jsonc"
const CLIENT_SOURCE_DIR = resolve(import.meta.dir, "../client")
const CLIENT_ENTRY = resolve(import.meta.dir, "../client/App.tsx")
const CLIENT_DIST_DIR = resolve(import.meta.dir, "../client/dist")
const CLIENT_BUNDLE = join(CLIENT_DIST_DIR, "App.js")
const CLIENT_CSS = join(CLIENT_DIST_DIR, "App.css")
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024
const MAX_SESSION_UPLOAD_BYTES = 100 * 1024 * 1024
const PROVIDER_ENDPOINT_ALIASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  sf: "https://api.siliconflow.cn/v1",
  deepseek: "https://api.deepseek.com/v1",
}
let clientBuildPromise: Promise<void> | undefined

export type UiServerOptions = {
  cwd?: string
  host?: string
  port?: number
  token?: string
  open?: boolean
  allowPublicHost?: boolean
}

export type UiServerHandle = {
  server: Server
  url: string
  token: string
  host: string
  port: number
  stop(): Promise<void>
}

type UiServerContext = {
  cwd?: string
  token: string
  runtime?: RuntimeWithoutLLM
  runs: Map<string, UiRunRecord>
  sessionPermissions: Map<string, Set<string>>
}

type ProviderConfigInput = {
  baseURL?: unknown
  apiKey?: unknown
  apiKeyEnv?: unknown
  model?: unknown
  credential?: unknown
}

type RunInput = {
  message?: unknown
  sessionId?: unknown
  permissionMode?: unknown
}

type SessionCreateInput = {
  title?: unknown
  projectId?: unknown
}

type ProjectCreateInput = {
  name?: unknown
  rootPath?: unknown
}

type ProjectUpdateInput = {
  name?: unknown
  rootPath?: unknown
}

type SessionUpdateInput = {
  title?: unknown
}

type SessionMoveInput = {
  projectId?: unknown
}

type UiFileSummary = {
  path: string
  size: number
  updatedAt: string
  kind: "text" | "binary"
}

type Server = ReturnType<typeof Bun.serve>

type UiRunRecord = {
  id: string
  input: {
    message: string
    sessionId?: string
    permissionMode: PermissionMode
  }
  status: RunStatus
  statusEvents: RunStatusEvent[]
  activity: ActivityItem[]
  events: AgentEvent[]
  toolCalls: Map<string, Extract<AgentEvent, { type: "tool_call" }>>
  controller: AbortController
  answer: string
  finishReason: string
  sessionId?: string
  error?: string
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>
  permissions: Map<string, UiPendingPermission>
  done: Promise<UiRunResult>
}

type UiPendingPermission = {
  id: string
  request: PermissionRequest
  decision: PermissionDecision
  resolve(decision: PermissionDecision): void
}

type UiRunResult = {
  runId: string
  status: TerminalRunStatus
  sessionId?: string
  answer: string
  finishReason: string
  events: AgentEvent[]
  error?: string
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const host = options.host ?? DEFAULT_UI_HOST
  const port = options.port ?? DEFAULT_UI_PORT
  assertHostAllowed(host, options.allowPublicHost === true)
  const token = options.token ?? createLocalToken()
  await ensureClientBundle()
  const context: UiServerContext = {
    token,
    runs: new Map(),
    sessionPermissions: new Map(),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }
  let server: Server
  try {
    server = Bun.serve({
      hostname: host,
      port,
      async fetch(request) {
        return handleUiRequest(request, context)
      },
    })
  } catch (cause) {
    throw new PixiuError(`UI port ${host}:${port} is already in use. Stop the existing process or choose another port with --port.`, {
      code: "UI_PORT_IN_USE",
      cause,
    })
  }
  const boundPort = server.port ?? port
  const url = `http://${host}:${boundPort}/?token=${encodeURIComponent(token)}`
  return {
    server,
    url,
    token,
    host,
    port: boundPort,
    async stop() {
      await context.runtime?.close()
      await cancelAllRuns(context)
      server.stop(true)
    },
  }
}

export async function createUiServer(options: { cwd?: string; token?: string } = {}) {
  const token = options.token ?? createLocalToken()
  const context: UiServerContext = {
    token,
    runs: new Map(),
    sessionPermissions: new Map(),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }
  return {
    token,
    async fetch(request: Request | string, init?: RequestInit) {
      const next = typeof request === "string" ? new Request(request, init) : request
      return handleUiRequest(next, context)
    },
    async close() {
      await context.runtime?.close()
      await cancelAllRuns(context)
    },
  }
}

export async function handleUiRequest(request: Request, context: UiServerContext): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (request.method === "GET" && url.pathname === "/") return htmlResponse(renderIndexHtml(context.token))
    if (request.method === "GET" && url.pathname === "/assets/client.js") return await clientBundleResponse()
    if (request.method === "GET" && url.pathname === "/assets/client.css") return await clientCssResponse()
    if (url.pathname.startsWith("/api/")) {
      const denied = authorizeApiRequest(request, url, context.token)
      if (denied) return denied
      return await routeApi(request, url, context)
    }
    return jsonResponse(apiFailure("NOT_FOUND", `No UI route for ${url.pathname}`), 404)
  } catch (error) {
    return jsonResponse(apiFailure(errorCode(error), formatError(error)), statusForError(error))
  }
}

async function routeApi(request: Request, url: URL, context: UiServerContext): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/status") {
    const runtime = await runtimeFor(context)
    const status: UiStatus = {
      version: UI_VERSION,
      cwd: runtime.cwd,
      provider: providerSummary(runtime.config),
      workspace: {
        mode: runtime.config.sandbox.mode,
        workspaceDir: runtime.config.sandbox.workspaceDir,
        workspaceOnly: runtime.config.sandbox.workspaceOnly,
        shellTimeoutMs: runtime.config.sandbox.shellTimeoutMs,
        outputMaxBytes: runtime.config.sandbox.outputMaxBytes,
      },
      sessionsPath: uiSessionsRoot(runtime.cwd),
      skills: {
        paths: runtime.config.skills.paths,
        diagnostics: (await runtime.skills.diagnostics()).length,
      },
      mcp: await mcpSummary(runtime.config),
    }
    return jsonResponse(apiSuccess(status))
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    const runtime = await runtimeFor(context)
    const body: UiConfigResponse = {
      config: redactConfig(runtime.config) as JsonValue,
      provider: providerSummary(runtime.config),
    }
    return jsonResponse(apiSuccess(body))
  }

  if (request.method === "POST" && url.pathname === "/api/config/provider") {
    const input = await readJsonBody<ProviderConfigInput>(request)
    await saveProviderConfig(context, input)
    await reloadRuntime(context)
    const runtime = await runtimeFor(context)
    return jsonResponse(apiSuccess({ provider: providerSummary(runtime.config) }))
  }

  if (request.method === "POST" && url.pathname === "/api/config/test-provider") {
    return jsonResponse(apiSuccess(await testProvider(context)))
  }

  if (request.method === "GET" && url.pathname === "/api/skills") {
    const runtime = await runtimeFor(context)
    const skills = await runtime.skills.list()
    const withReferences = await Promise.all(skills.map(async (skill) => ({
      ...skill,
      referenceCount: (await runtime.skills.files(skill.name)).length,
    })))
    return jsonResponse(apiSuccess({ skills: withReferences }))
  }

  if (request.method === "GET" && url.pathname === "/api/mcp") {
    const runtime = await runtimeFor(context)
    const statuses = await inspectMCPServers(runtime.config)
    return jsonResponse(apiSuccess({ servers: statuses.map((status) => mcpServerSummary(status, runtime.config.mcp[status.name])) }))
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const runtime = await runtimeFor(context)
    const projectId = url.searchParams.get("projectId") ?? undefined
    const project = projectId ? await runtime.projects.get(projectId) : undefined
    if (projectId && !project) throw new PixiuError(`Unknown project: ${projectId}`, { code: "PROJECT_NOT_FOUND" })
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    const sessions = visibleSessions(await runtime.sessions.listSessions())
      .filter((session) => !projectId || sessionProjectId(session, fallbackProjectId) === projectId)
    return jsonResponse(apiSuccess({ sessions: await Promise.all(sessions.map((session) => sessionSummary(session, fallbackProjectId))) }))
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const input = await readJsonBody<SessionCreateInput>(request)
    const runtime = await runtimeFor(context)
    const session = await createUiSession(runtime, input)
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    return jsonResponse(apiSuccess({ session: await sessionSummary(session, fallbackProjectId), files: await listSessionFiles(session) }))
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    const runtime = await runtimeFor(context)
    const sessions = visibleSessions(await runtime.sessions.listSessions())
    const projects = await runtime.projects.list()
    const currentProject = await runtime.projects.current()
    const fallbackProjectId = fallbackProjectIdFromProjects(projects)
    return jsonResponse(apiSuccess({
      projects: projects.map((project) => projectSummary(project, sessions, fallbackProjectId)),
      currentProjectId: currentProject.id,
    }))
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    const input = await readJsonBody<ProjectCreateInput>(request)
    const runtime = await runtimeFor(context)
    const project = await runtime.projects.create({
      ...(typeof input.name === "string" ? { name: input.name } : {}),
      ...(typeof input.rootPath === "string" ? { rootPath: input.rootPath } : {}),
    })
    return jsonResponse(apiSuccess({ project: projectSummary(project, [], project.id) }))
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
  if (projectMatch && request.method === "PATCH") {
    const input = await readJsonBody<ProjectUpdateInput>(request)
    const runtime = await runtimeFor(context)
    const project = await runtime.projects.update(decodeURIComponent(projectMatch[1] ?? ""), {
      ...(typeof input.name === "string" ? { name: input.name } : {}),
      ...(typeof input.rootPath === "string" ? { rootPath: input.rootPath } : {}),
    })
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    const sessions = visibleSessions(await runtime.sessions.listSessions())
    return jsonResponse(apiSuccess({ project: projectSummary(project, sessions, fallbackProjectId) }))
  }

  if (projectMatch && request.method === "DELETE") {
    const runtime = await runtimeFor(context)
    const projectId = decodeURIComponent(projectMatch[1] ?? "")
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    const sessions = visibleSessions(await runtime.sessions.listSessions())
    const sessionCount = sessions.filter((session) => sessionProjectId(session, fallbackProjectId) === projectId).length
    if (sessionCount > 0) {
      throw new PixiuError("Project is not empty. Move or remove sessions from this project first.", { code: "PROJECT_NOT_EMPTY" })
    }
    const removed = await runtime.projects.remove(projectId)
    return jsonResponse(apiSuccess({ project: projectSummary(removed, [], fallbackProjectId) }))
  }

  const projectSelectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/select$/)
  if (projectSelectMatch && request.method === "POST") {
    const runtime = await runtimeFor(context)
    const project = await runtime.projects.setCurrent(decodeURIComponent(projectSelectMatch[1] ?? ""))
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    const sessions = visibleSessions(await runtime.sessions.listSessions())
    return jsonResponse(apiSuccess({ project: projectSummary(project, sessions, fallbackProjectId) }))
  }

  const sessionUploadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/uploads$/)
  if (request.method === "POST" && sessionUploadMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionUploadMatch[1] ?? ""))
    const files = await uploadSessionFiles(session, request)
    await persistUploadedFileRefs(runtime, session, files)
    return jsonResponse(apiSuccess({ files }))
  }

  const sessionFilesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files$/)
  if (request.method === "GET" && sessionFilesMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionFilesMatch[1] ?? ""))
    return jsonResponse(apiSuccess({ files: await listSessionFiles(session) }))
  }

  const sessionFileContentMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files\/content$/)
  if (request.method === "GET" && sessionFileContentMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionFileContentMatch[1] ?? ""))
    const path = url.searchParams.get("path") ?? ""
    return jsonResponse(apiSuccess(await readSessionFileContent(session, path)))
  }

  const sessionDetailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
  if (request.method === "GET" && sessionDetailMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionDetailMatch[1] ?? ""))
    if (isDeletedSession(session)) throw new PixiuError(`Unknown session: ${session.id}`, { code: "SESSION_NOT_FOUND" })
    const messages = await runtime.sessions.readMessages(session.id)
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    return jsonResponse(apiSuccess({
      session: await sessionSummary(session, fallbackProjectId, messages),
      messages,
      evidence: collectSessionEvidence(messages),
      files: await listSessionFiles(session),
      todos: await runtime.sessions.getTodos(session.id),
      activity: sessionActivity(session),
    }))
  }

  if (request.method === "PATCH" && sessionDetailMatch) {
    const input = await readJsonBody<SessionUpdateInput>(request)
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionDetailMatch[1] ?? ""))
    if (isDeletedSession(session)) throw new PixiuError(`Unknown session: ${session.id}`, { code: "SESSION_NOT_FOUND" })
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 100) : undefined
    if (!title) throw new PixiuError("title is required", { code: "SESSION_UPDATE_INVALID" })
    const metadata = sessionMetadata(session)
    const updated = await runtime.sessions.updateSession(session.id, {
      title,
      metadata: {
        ...metadata,
        titleSource: "user",
      },
    })
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    return jsonResponse(apiSuccess({ session: await sessionSummary(updated, fallbackProjectId) }))
  }

  if (request.method === "DELETE" && sessionDetailMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionDetailMatch[1] ?? ""))
    const metadata = sessionMetadata(session)
    const updated = await runtime.sessions.updateSession(session.id, {
      metadata: {
        ...metadata,
        deletedAt: new Date().toISOString(),
      },
    })
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    return jsonResponse(apiSuccess({ session: await sessionSummary(updated, fallbackProjectId) }))
  }

  const sessionMoveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/move$/)
  if (request.method === "POST" && sessionMoveMatch) {
    const input = await readJsonBody<SessionMoveInput>(request)
    const runtime = await runtimeFor(context)
    const projectId = typeof input.projectId === "string" ? input.projectId.trim() : ""
    if (!projectId) throw new PixiuError("projectId is required", { code: "SESSION_MOVE_INVALID" })
    const project = await runtime.projects.get(projectId)
    if (!project) throw new PixiuError(`Unknown project: ${projectId}`, { code: "PROJECT_NOT_FOUND" })
    const session = await requireSession(runtime, decodeURIComponent(sessionMoveMatch[1] ?? ""))
    if (isDeletedSession(session)) throw new PixiuError(`Unknown session: ${session.id}`, { code: "SESSION_NOT_FOUND" })
    const updated = await runtime.sessions.updateSession(session.id, {
      metadata: {
        ...sessionMetadata(session),
        projectId: project.id,
      },
    })
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    return jsonResponse(apiSuccess({ session: await sessionSummary(updated, fallbackProjectId) }))
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    const input = await readJsonBody<RunInput>(request)
    const run = startAgentRun(context, input)
    if (url.searchParams.get("wait") === "1") return jsonResponse(apiSuccess(await run.done))
    return jsonResponse(apiSuccess({ runId: run.id, status: run.status }))
  }

  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (request.method === "GET" && runEventsMatch) {
    const run = context.runs.get(decodeURIComponent(runEventsMatch[1] ?? ""))
    if (!run) return jsonResponse(apiFailure("RUN_NOT_FOUND", "Unknown run."), 404)
    return streamRunEvents(run, request.signal)
  }

  const runCancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
  if (request.method === "POST" && runCancelMatch) {
    const run = context.runs.get(decodeURIComponent(runCancelMatch[1] ?? ""))
    if (!run) return jsonResponse(apiFailure("RUN_NOT_FOUND", "Unknown run."), 404)
    run.controller.abort()
    denyPendingPermissions(run, "cancelled")
    if (!isRunTerminal(run)) {
      setRunStatus(run, "cancelled", { message: "Run cancelled.", phase: "finalizing" })
      if (!run.finishReason) run.finishReason = "cancelled"
    }
    return jsonResponse(apiSuccess({ runId: run.id, status: "cancelled" }))
  }

  const permissionMatch = url.pathname.match(/^\/api\/permissions\/([^/]+)$/)
  if (request.method === "POST" && permissionMatch) {
    const input = await readJsonBody<{ action?: unknown; scope?: unknown }>(request)
    if (input.action !== "allow" && input.action !== "deny") {
      throw new PixiuError("permission action must be allow or deny", { code: "UI_PERMISSION_INVALID" })
    }
    if (input.scope !== undefined && input.scope !== "once" && input.scope !== "sessionSimilar") {
      throw new PixiuError("permission scope must be once or sessionSimilar", { code: "UI_PERMISSION_INVALID" })
    }
    const result = resolvePermission(context, decodeURIComponent(permissionMatch[1] ?? ""), input)
    return jsonResponse(apiSuccess(result))
  }

  return jsonResponse(apiFailure("NOT_FOUND", `No API route for ${request.method} ${url.pathname}`), 404)
}

async function runtimeFor(context: UiServerContext) {
  if (!context.runtime) context.runtime = await buildRuntime({ ...(context.cwd ? { cwd: context.cwd } : {}), loadLLM: false })
  return context.runtime
}

async function reloadRuntime(context: UiServerContext) {
  await context.runtime?.close()
  delete context.runtime
}

async function readJsonBody<T>(request: Request): Promise<T> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch (cause) {
    throw new PixiuError("Request body must be valid JSON.", { code: "UI_JSON_INVALID", cause })
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PixiuError("Request body must be a JSON object.", { code: "UI_JSON_INVALID" })
  }
  return parsed as T
}

function startAgentRun(context: UiServerContext, input: RunInput) {
  const message = typeof input.message === "string" ? input.message.trim() : ""
  if (!message) throw new PixiuError("message is required", { code: "UI_RUN_INVALID" })
  const permissionMode = parsePermissionMode(typeof input.permissionMode === "string" ? input.permissionMode : undefined)
  const sessionId = typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : undefined
  const run: UiRunRecord = {
    id: createRunId(),
    input: sessionId ? { message, sessionId, permissionMode } : { message, permissionMode },
    status: "queued",
    statusEvents: [],
    activity: [],
    events: [],
    toolCalls: new Map(),
    controller: new AbortController(),
    answer: "",
    finishReason: "",
    subscribers: new Set(),
    permissions: new Map(),
    done: Promise.resolve(undefined as never),
  }
  context.runs.set(run.id, run)
  setRunStatus(run, "queued", { message: "Run queued.", phase: "starting" })
  run.done = Promise.resolve().then(() => executeRun(context, run))
  return run
}

async function executeRun(context: UiServerContext, run: UiRunRecord): Promise<UiRunResult> {
  let runtime: Runtime | undefined
  try {
    if (run.controller.signal.aborted) {
      if (run.status !== "cancelled") {
        setRunStatus(run, "cancelled", { message: "Run cancelled.", phase: "finalizing" })
      }
      if (!run.finishReason) run.finishReason = "cancelled"
      return runResult(run)
    }
    setRunStatus(run, "running", { message: "Run started.", phase: "starting" })
    runtime = await buildRuntime({
      ...(context.cwd ? { cwd: context.cwd } : {}),
      permissionMode: run.input.permissionMode,
      yes: run.input.permissionMode === "bypassPermissions",
      interactivePermissions: run.input.permissionMode !== "bypassPermissions" && run.input.permissionMode !== "plan",
      askPermission: (request, decision) => checkUiPermission(context, run, request, decision),
      signal: run.controller.signal,
    })
    for await (const event of runtime.runner.run(
      run.input.sessionId
        ? { message: run.input.message, sessionId: run.input.sessionId, signal: run.controller.signal }
        : { message: run.input.message, signal: run.controller.signal },
    )) {
      run.events.push(event)
      if (event.type === "llm_text_delta") run.answer += event.text
      if (event.type === "message") run.answer = event.content
      if (event.type === "session_created") run.sessionId = event.sessionId
      if (event.type === "tool_call") {
        run.toolCalls.set(event.id, event)
        emitToolIntentActivity(run, event)
      }
      if (event.type === "tool_result") emitToolActivity(run, event)
      if (event.type === "finish") {
        if (run.status !== "cancelled") run.finishReason = event.reason
        else if (!run.finishReason) run.finishReason = "cancelled"
        run.sessionId = event.sessionId
      }
      emitRunEvent(run, "agent_event", redactForUi(event))
    }
    if (run.controller.signal.aborted) {
      if (run.status !== "cancelled") {
        setRunStatus(run, "cancelled", { message: "Run cancelled.", phase: "finalizing" })
      }
      if (!run.finishReason) run.finishReason = "cancelled"
    } else {
      setRunStatus(run, run.finishReason === "error" ? "error" : "idle", {
        message: run.finishReason === "error" ? "Run failed." : "Run finished.",
        phase: "finalizing",
      })
    }
  } catch (error) {
    if (run.controller.signal.aborted) {
      if (run.status !== "cancelled") {
        setRunStatus(run, "cancelled", { message: "Run cancelled.", phase: "finalizing" })
      }
    } else {
      setRunStatus(run, "error", { message: "Run failed.", phase: "finalizing" })
    }
    run.error = formatError(error)
    if (!run.finishReason) run.finishReason = run.status
    emitRunEvent(run, "error", { message: redactSecrets(run.error) })
  } finally {
    if (runtime && run.sessionId) await updateUiSessionRunMetadata(runtime, run).catch(() => undefined)
    await runtime?.close()
    const result = runResult(run)
    emitRunEvent(run, "result", result)
    closeRunSubscribers(run)
  }
  return runResult(run)
}

function runResult(run: UiRunRecord): UiRunResult {
  return redactForUi({
    runId: run.id,
    status: terminalRunStatus(run.status),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    answer: run.answer,
    finishReason: run.finishReason,
    events: redactForUi(run.events) as AgentEvent[],
    ...(run.error ? { error: run.error } : {}),
  }) as UiRunResult
}

function parsePermissionMode(value: string | undefined): PermissionMode {
  if (value === "default" || value === "acceptEdits" || value === "bypassPermissions" || value === "plan") return value
  return "acceptEdits"
}

function checkUiPermission(
  context: UiServerContext,
  run: UiRunRecord,
  request: PermissionRequest,
  decision: PermissionDecision,
) {
  const sessionId = run.sessionId
  const key = permissionSimilarityKey(request, decision)
  if (sessionId && context.sessionPermissions.get(sessionId)?.has(key)) {
    return Promise.resolve({
      ...decision,
      action: "allow" as const,
      originalAction: "ask" as const,
      reason: `approved by UI session rule: ${decision.reason}`,
    })
  }
  return askUiPermission(run, request, decision, key)
}

function askUiPermission(run: UiRunRecord, request: PermissionRequest, decision: PermissionDecision, similarityKey: string) {
  return new Promise<PermissionDecision>((resolve) => {
    const pending: UiPendingPermission = {
      id: createPermissionId(),
      request,
      decision,
      resolve,
    }
    run.permissions.set(pending.id, pending)
    appendActivity(run, {
      id: stableActivityId("act_perm", run.id, pending.id, "waiting"),
      runId: run.id,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      kind: "permission",
      status: "running",
      title: "Waiting for permission",
      summary: `Waiting for approval to run ${request.tool}`,
      toolName: request.tool,
      startedAt: new Date().toISOString(),
      rawEventIds: [`permission_request:${pending.id}`],
    })
    setRunStatus(run, "waiting_for_permission", {
      message: `Waiting for permission: ${request.tool}`,
      phase: "permission",
      permissionId: pending.id,
      toolName: request.tool,
    })
    emitRunEvent(run, "permission_request", {
      id: pending.id,
      runId: run.id,
      request,
      decision,
      similarityKey,
    })
  })
}

function resolvePermission(context: UiServerContext, permissionId: string, input: { action?: unknown; scope?: unknown }) {
  for (const run of context.runs.values()) {
    const pending = run.permissions.get(permissionId)
    if (!pending) continue
    const allow = input.action === "allow"
    if (allow && input.scope === "sessionSimilar" && run.sessionId) {
      const ruleSet = context.sessionPermissions.get(run.sessionId) ?? new Set<string>()
      ruleSet.add(permissionSimilarityKey(pending.request, pending.decision))
      context.sessionPermissions.set(run.sessionId, ruleSet)
    }
    const decision: PermissionDecision = allow
      ? {
          ...pending.decision,
          action: "allow",
          originalAction: "ask",
          reason: `${input.scope === "sessionSimilar" ? "approved for this UI session" : "approved once"}: ${pending.decision.reason}`,
        }
      : {
          ...pending.decision,
          action: "deny",
          originalAction: "ask",
          reason: `denied by user: ${pending.decision.reason}`,
    }
    run.permissions.delete(permissionId)
    appendActivity(run, {
      id: stableActivityId("act_perm", run.id, permissionId, decision.action),
      runId: run.id,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      kind: "permission",
      status: decision.action === "allow" ? "success" : "skipped",
      title: decision.action === "allow" ? "Permission approved" : "Permission denied",
      summary: `${decision.action === "allow" ? "Approved" : "Denied"} ${pending.request.tool}`,
      toolName: pending.request.tool,
      endedAt: new Date().toISOString(),
      rawEventIds: [`permission_result:${permissionId}`],
    })
    if (run.status === "waiting_for_permission") {
      setRunStatus(run, "running", {
        message: decision.action === "allow" ? "Permission approved. Resuming run." : "Permission denied. Resuming run.",
        phase: "permission",
        permissionId,
        toolName: pending.request.tool,
      })
    }
    pending.resolve(decision)
    emitRunEvent(run, "permission_result", { id: permissionId, action: decision.action, reason: decision.reason })
    return { id: permissionId, action: decision.action }
  }
  throw new PixiuError(`Unknown permission request: ${permissionId}`, { code: "PERMISSION_NOT_FOUND" })
}

function permissionSimilarityKey(request: PermissionRequest, decision: PermissionDecision) {
  const rule = decision.rule
  if (rule) return [request.tool, rule.index, rule.tool ?? "", rule.pattern ?? ""].join(":")
  return [request.tool, request.risk ?? "", stablePermissionInput(request.input)].join(":")
}

function stablePermissionInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value)
  const record = value as Record<string, unknown>
  const stable: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) stable[key] = record[key]
  return JSON.stringify(stable)
}

function streamRunEvents(run: UiRunRecord, signal?: AbortSignal) {
  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      for (const event of replayRunEvents(run)) {
        controller.enqueue(encoder.encode(formatSSE(event.event, event.data)))
      }
      if (isRunTerminal(run)) {
        controller.enqueue(encoder.encode(formatSSE("result", runResult(run))))
        controller.close()
        return
      }
      run.subscribers.add(controller)
      const cleanup = () => {
        run.subscribers.delete(controller)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
      signal?.addEventListener("abort", cleanup, { once: true })
    },
    cancel() {
      if (controllerRef) run.subscribers.delete(controllerRef)
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  })
}

function replayRunEvents(run: UiRunRecord) {
  return [
    ...run.statusEvents.map((data) => ({ event: "run_status", data })),
    { event: "run", data: legacyRunEventData(run) },
    ...(run.activity.length
      ? [{ event: "activity_updated", data: activityUpdatedEvent(run, run.activity.at(-1)) }]
      : []),
    ...run.events.map((data) => ({ event: "agent_event", data })),
  ]
}

function emitToolActivity(run: UiRunRecord, event: Extract<AgentEvent, { type: "tool_result" }>) {
  const call = run.toolCalls.get(event.id)
  const resultActivity = activityFromToolResult({
    runId: run.id,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    toolCallId: event.id,
    toolName: event.name,
    input: call?.input,
    ok: event.ok,
    content: event.content,
    metadata: event.metadata,
    endedAt: new Date().toISOString(),
  })
  const existing = run.activity.find((item) => item.toolCallId === event.id)
  appendActivity(run, existing ? updateActivityWithToolResult(existing, resultActivity, event.ok) : resultActivity)
}

function emitToolIntentActivity(run: UiRunRecord, event: Extract<AgentEvent, { type: "tool_call" }>) {
  const item = activityFromToolIntent({
    runId: run.id,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    toolCallId: event.id,
    toolName: event.name,
    input: event.input,
    startedAt: new Date().toISOString(),
  })
  if (item) appendActivity(run, item)
}

function appendActivity(run: UiRunRecord, item: ActivityItem) {
  const index = run.activity.findIndex((activity) => activity.id === item.id)
  const next = index >= 0
    ? [...run.activity.slice(0, index), item, ...run.activity.slice(index + 1)]
    : [...run.activity, item]
  run.activity = limitActivityItems(next)
  emitRunEvent(run, "activity_updated", activityUpdatedEvent(run, item))
}

function activityUpdatedEvent(run: UiRunRecord, item: ActivityItem | undefined): ActivityUpdatedEvent {
  return {
    type: "activity_updated",
    runId: run.id,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    activity: run.activity,
    ...(item ? { item } : {}),
  }
}

function setRunStatus(
  run: UiRunRecord,
  status: RunStatus,
  options: {
    phase?: RunStatusPhase
    message?: string
    toolCallId?: string
    toolName?: string
    permissionId?: string
  } = {},
) {
  run.status = status
  const event: RunStatusEvent = {
    type: "run_status",
    runId: run.id,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    status,
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.message ? { message: options.message } : {}),
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
    ...(options.permissionId ? { permissionId: options.permissionId } : {}),
    updatedAt: new Date().toISOString(),
  }
  run.statusEvents.push(event)
  emitRunEvent(run, "run_status", event)
  emitRunEvent(run, "run", legacyRunEventData(run))
}

function legacyRunEventData(run: UiRunRecord) {
  const status =
    run.status === "waiting_for_permission"
      ? "waiting_permission"
      : run.status === "idle"
        ? "done"
        : run.status
  return {
    runId: run.id,
    status,
    runStatus: run.status,
  }
}

function emitRunEvent(run: UiRunRecord, event: string, data: unknown) {
  const chunk = new TextEncoder().encode(formatSSE(event, redactForUi(data)))
  for (const subscriber of [...run.subscribers]) {
    try {
      subscriber.enqueue(chunk)
    } catch {
      run.subscribers.delete(subscriber)
    }
  }
}

function closeRunSubscribers(run: UiRunRecord) {
  for (const subscriber of [...run.subscribers]) {
    try {
      subscriber.close()
    } catch {
      // already closed
    }
  }
  run.subscribers.clear()
}

function isRunTerminal(run: UiRunRecord) {
  return isTerminalRunStatus(run.status)
}

function terminalRunStatus(status: RunStatus): TerminalRunStatus {
  return isTerminalRunStatus(status) ? status : "cancelled"
}

function formatSSE(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(redactForUi(data))}\n\n`
}

function redactForUi(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactForUi)
  if (!value || typeof value !== "object") return value
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    next[key] = isSecretConfigKey(key) ? "[redacted]" : redactForUi(item)
  }
  return next
}

async function cancelAllRuns(context: UiServerContext) {
  for (const run of context.runs.values()) {
    if (!isRunTerminal(run)) {
      run.controller.abort()
      denyPendingPermissions(run, "server shutdown")
    }
  }
  await Promise.all([...context.runs.values()].map((run) => run.done.catch(() => undefined)))
}

function denyPendingPermissions(run: UiRunRecord, reason: string) {
  for (const pending of run.permissions.values()) {
    pending.resolve({
      ...pending.decision,
      action: "deny",
      originalAction: "ask",
      reason: `${reason}: ${pending.decision.reason}`,
    })
  }
  run.permissions.clear()
}

function createRunId() {
  return `run_${randomBytes(9).toString("base64url")}`
}

function createPermissionId() {
  return `perm_${randomBytes(9).toString("base64url")}`
}

async function saveProviderConfig(context: UiServerContext, input: ProviderConfigInput) {
  const cwd = resolve(context.cwd ?? process.cwd())
  const baseURL = normalizeProviderEndpoint(stringInput(input.baseURL, "baseURL"))
  const model = stringInput(input.model, "model")
  const credential = input.credential === "apiKeyEnv" ? "apiKeyEnv" : "apiKey"
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : ""
  const apiKeyEnv = typeof input.apiKeyEnv === "string" ? input.apiKeyEnv.trim() : ""

  const projectConfig = await readProjectConfig(cwd)
  const providers = objectValue(projectConfig.providers)
  const provider = objectValue(providers["openai-compatible"])
  const existingApiKey = typeof provider.apiKey === "string" ? provider.apiKey : ""
  const nextApiKey = credential === "apiKey" ? apiKey || existingApiKey : ""
  if (credential === "apiKey" && !nextApiKey) throw new PixiuError("apiKey is required", { code: "UI_CONFIG_INVALID" })
  if (credential === "apiKeyEnv" && !apiKeyEnv) throw new PixiuError("apiKeyEnv is required", { code: "UI_CONFIG_INVALID" })
  providers["openai-compatible"] = {
    ...provider,
    type: "openai-compatible",
    baseURL,
    model,
    ...(credential === "apiKey" ? { apiKey: nextApiKey, apiKeyEnv: undefined } : { apiKey: undefined, apiKeyEnv }),
  }
  projectConfig.providers = providers
  projectConfig.model = model
  await writeProjectConfig(cwd, removeUndefinedDeep(projectConfig) as Record<string, unknown>)
}

async function testProvider(context: UiServerContext) {
  const runtime = await runtimeFor(context)
  const provider = resolveProviderConfig(runtime.config)
  if (!provider.apiKey) throw new PixiuError("No provider API key configured.", { code: "PROVIDER_API_KEY_MISSING" })
  const client = new OpenAICompatibleClient({
    baseURL: provider.baseURL ?? "https://api.openai.com/v1",
    apiKey: provider.apiKey,
  })
  let text = ""
  for await (const event of client.stream({
    model: provider.model ?? runtime.config.model,
    messages: [
      { role: "system", content: "You are a provider health check. Reply briefly." },
      { role: "user", content: "Reply with: ok" },
    ],
    toolChoice: "none",
  })) {
    if (event.type === "text_delta") text += event.text
    if (event.type === "error") throw new PixiuError(event.error, { code: event.code ?? "PROVIDER_TEST_FAILED" })
  }
  return {
    ok: true,
    model: provider.model ?? runtime.config.model,
    text: text.trim().slice(0, 200),
  }
}

async function readProjectConfig(cwd: string) {
  const path = resolve(cwd, CONFIG_FILE)
  try {
    await access(path)
    const parsed = await readJsoncFile<Record<string, unknown>>(path)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
    return {}
  }
}

async function writeProjectConfig(cwd: string, config: Record<string, unknown>) {
  const path = resolve(cwd, CONFIG_FILE)
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
}

function stringInput(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new PixiuError(`${label} is required`, { code: "UI_CONFIG_INVALID" })
  return value.trim()
}

function normalizeProviderEndpoint(value: string) {
  const alias = PROVIDER_ENDPOINT_ALIASES[value.toLowerCase()]
  const endpoint = alias ?? value
  try {
    const url = new URL(endpoint)
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol")
  } catch {
    throw new PixiuError(`Invalid provider API URL: ${value}`, { code: "UI_CONFIG_INVALID" })
  }
  return endpoint.replace(/\/+$/, "")
}

function removeUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefinedDeep)
  if (!value || typeof value !== "object") return value
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    next[key] = removeUndefinedDeep(item)
  }
  return next
}

function authorizeApiRequest(request: Request, url: URL, token: string) {
  const header = request.headers.get("authorization")
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]
  const queryToken = url.searchParams.get("token")
  if (bearer === token || queryToken === token) return undefined
  return jsonResponse(apiFailure("UNAUTHORIZED", "Missing or invalid local UI token."), 401)
}

function providerSummary(config: PixiuConfig): UiProviderSummary {
  const provider = config.providers["openai-compatible"]
  const envValue = provider?.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined
  const credential = provider?.apiKey ? "apiKey" : provider?.apiKeyEnv ? "apiKeyEnv" : "none"
  return {
    ...(provider?.baseURL ? { baseURL: provider.baseURL } : {}),
    model: provider?.model ?? config.model,
    credential,
    ...(provider?.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    keyPresent: Boolean(provider?.apiKey || envValue),
  }
}

async function mcpSummary(config: PixiuConfig) {
  const statuses = await inspectMCPServers(config)
  return {
    configured: statuses.length,
    connected: statuses.filter((server) => server.status === "connected").length,
    failed: statuses.filter((server) => server.status === "failed").length,
    disabled: statuses.filter((server) => server.status === "disabled").length,
  }
}

function mcpServerSummary(status: MCPServerStatus, config: PixiuConfig["mcp"][string] | undefined) {
  return {
    ...status,
    enabled: config?.enabled !== false,
    ...(config?.command ? { command: [config.command, ...(config.args ?? [])].join(" ") } : {}),
    ...(config?.url ? { url: config.url } : {}),
  }
}

async function fallbackProjectIdFor(runtime: RuntimeWithoutLLM) {
  return fallbackProjectIdFromProjects(await runtime.projects.list())
}

function fallbackProjectIdFromProjects(projects: ProjectRecord[]) {
  return projects.find((project) => project.id === DEFAULT_PROJECT_ID)?.id ?? projects[0]?.id ?? DEFAULT_PROJECT_ID
}

function projectSummary(project: ProjectRecord, sessions: SessionRecord[], fallbackProjectId: string): UiProjectSummary {
  const projectSessions = sessions.filter((session) => sessionProjectId(session, fallbackProjectId) === project.id)
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    sessionCount: projectSessions.length,
    ...(projectSessions[0]?.id ? { lastSessionId: projectSessions[0].id } : {}),
  }
}

async function sessionSummary(
  session: SessionRecord,
  fallbackProjectId: string,
  messages?: SessionMessage[],
): Promise<UiSessionSummary> {
  const metadata = sessionMetadata(session)
  const workspaceDir = typeof metadata.workspaceDir === "string" ? metadata.workspaceDir : undefined
  const model = typeof metadata.model === "string" ? metadata.model : undefined
  const finishStatus = normalizePersistedRunStatus(metadata.finishStatus)
  const projectId = sessionProjectId(session, fallbackProjectId)
  const titleSource = metadata.titleSource === "user" ? "user" : metadata.titleSource === "auto" ? "auto" : undefined
  const activity = sessionActivity(session)
  const detailMessages = messages ?? []
  const evidence = detailMessages.length ? collectSessionEvidence(detailMessages) : undefined
  const preview = previewFromMessages(detailMessages)
  return {
    id: session.id,
    projectId,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.title ? { title: session.title } : {}),
    ...(titleSource ? { titleSource } : {}),
    ...(model ? { model } : {}),
    ...(finishStatus ? { finishStatus } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(preview ? { preview } : {}),
    ...(evidence ? { artifactCount: evidence.artifacts.length } : {}),
    ...(activity.length ? { activityCount: activity.length } : {}),
    summaryApproxTokens: session.summary ? approximateTokens(session.summary) : 0,
  }
}

function sessionActivity(session: SessionRecord | undefined) {
  const metadata = sessionMetadata(session)
  return normalizePersistedActivityItems(metadata.activity)
}

function sessionMetadata(session: SessionRecord | undefined): JsonObject {
  return session?.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? { ...session.metadata } : {}
}

function sessionProjectId(session: SessionRecord, fallbackProjectId: string) {
  const metadata = sessionMetadata(session)
  return typeof metadata.projectId === "string" && metadata.projectId.trim() ? metadata.projectId.trim() : fallbackProjectId
}

function visibleSessions(sessions: SessionRecord[]) {
  return sessions.filter((session) => !isDeletedSession(session))
}

function isDeletedSession(session: SessionRecord) {
  const metadata = sessionMetadata(session)
  return typeof metadata.deletedAt === "string" && Boolean(metadata.deletedAt)
}

function previewFromMessages(messages: SessionMessage[]) {
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.parts
      .filter((part): part is Extract<SessionMessage["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text.slice(0, 160)
  }
  return undefined
}

async function updateUiSessionRunMetadata(runtime: Runtime, run: UiRunRecord) {
  if (!run.sessionId) return
  const session = await runtime.sessions.getSession(run.sessionId)
  const metadata = sessionMetadata(session)
  const messages = session ? await runtime.sessions.readMessages(session.id) : []
  const artifacts = session ? await artifactRefsForSession(session, messages) : []
  await runtime.sessions.updateSession(run.sessionId, {
    metadata: {
      ...metadata,
      model: providerSummary(runtime.config).model,
      finishStatus: terminalRunStatus(run.status),
      finishReason: run.finishReason,
      lastRunId: run.id,
      artifacts,
      activity: limitActivityItems([
        ...sessionActivity(session),
        ...run.activity.map((item) => ({
          ...item,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        })),
      ]),
    },
  })
}

async function persistUploadedFileRefs(runtime: RuntimeWithoutLLM, session: SessionRecord, files: UiFileSummary[]) {
  if (!files.length) return
  const metadata = sessionMetadata(session)
  const existing = Array.isArray(metadata.fileReferences) ? metadata.fileReferences : []
  const byKey = new Map<string, JsonValue>()
  for (const item of existing) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const path = typeof item.path === "string" ? item.path : undefined
    const source = typeof item.source === "string" ? item.source : "uploaded"
    if (path) byKey.set(`${source}:${path}`, item)
  }
  const createdAt = new Date().toISOString()
  for (const file of files) {
    byKey.set(`uploaded:${file.path}`, {
      path: file.path,
      source: "uploaded",
      size: file.size,
      kind: file.kind,
      createdAt,
    })
  }
  await runtime.sessions.updateSession(session.id, {
    metadata: {
      ...metadata,
      fileReferences: [...byKey.values()],
    },
  })
}

async function artifactRefsForSession(session: SessionRecord, messages: SessionMessage[]) {
  const evidence = collectSessionEvidence(messages)
  const guard = new PathGuard({ workspaceRoot: session.cwd, workspaceOnly: true })
  const refs: JsonObject[] = []
  for (const artifact of evidence.artifacts) {
    let exists = false
    try {
      await stat(guard.resolvePath(artifact.path).absolutePath)
      exists = true
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
    }
    refs.push({
      path: artifact.path,
      kind: "artifact",
      tool: artifact.tool,
      createdAt: artifact.createdAt,
      sourceToolCallId: artifact.messageId,
      exists,
    })
  }
  return refs
}

async function createUiSession(runtime: RuntimeWithoutLLM, input: SessionCreateInput) {
  const id = createID("session")
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 80) : "New chat"
  const projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : (await runtime.projects.current()).id
  if (!(await runtime.projects.get(projectId))) throw new PixiuError(`Unknown project: ${projectId}`, { code: "PROJECT_NOT_FOUND" })
  if (runtime.config.sandbox.mode === "workspace") {
    const workspaceRoot =
      runtime.config.sandbox.workspaceDir && isAbsolute(runtime.config.sandbox.workspaceDir)
        ? runtime.config.sandbox.workspaceDir
        : resolve(runtime.cwd, runtime.config.sandbox.workspaceDir)
    const sessionRoot = join(workspaceRoot, id)
    await mkdir(sessionRoot, { recursive: true })
    return runtime.sessions.create({
      id,
      cwd: sessionRoot,
      title,
      metadata: {
        projectId,
        titleSource: "user",
        sandboxMode: "workspace",
        workspaceDir: relative(runtime.cwd, sessionRoot),
        model: providerSummary(runtime.config).model,
        finishStatus: "idle",
      },
    })
  }
  return runtime.sessions.create({
    id,
    cwd: runtime.cwd,
    title,
    metadata: {
      projectId,
      titleSource: "user",
      sandboxMode: runtime.config.sandbox.mode,
      workspaceDir: ".",
      model: providerSummary(runtime.config).model,
      finishStatus: "idle",
    },
  })
}

async function requireSession(runtime: RuntimeWithoutLLM, sessionId: string) {
  const session = await runtime.sessions.getSession(sessionId)
  if (!session) throw new PixiuError(`Unknown session: ${sessionId}`, { code: "SESSION_NOT_FOUND" })
  return session
}

async function uploadSessionFiles(session: SessionRecord, request: Request) {
  const form = await request.formData()
  const uploads: UiFileSummary[] = []
  const currentUploadBytes = await sessionUploadBytes(session.cwd)
  let nextUploadBytes = currentUploadBytes
  const uploadRoot = join(session.cwd, "uploads")
  await mkdir(uploadRoot, { recursive: true })
  const guard = new PathGuard({ workspaceRoot: session.cwd, workspaceOnly: true })
  for (const value of form.getAll("files")) {
    if (!(value instanceof File)) continue
    if (value.size > MAX_UPLOAD_FILE_BYTES) {
      throw new PixiuError(`Upload too large: ${value.name}`, { code: "UPLOAD_TOO_LARGE" })
    }
    nextUploadBytes += value.size
    if (nextUploadBytes > MAX_SESSION_UPLOAD_BYTES) {
      throw new PixiuError("Session uploads exceed the 100 MB limit.", { code: "UPLOAD_TOO_LARGE" })
    }
    const safeName = safeUploadName(value.name)
    const target = guard.resolvePath(join("uploads", safeName))
    await writeFile(target.absolutePath, Buffer.from(await value.arrayBuffer()))
    const info = await stat(target.absolutePath)
    uploads.push({
      path: target.relativePath,
      size: info.size,
      updatedAt: info.mtime.toISOString(),
      kind: isTextLikePath(target.relativePath) ? "text" : "binary",
    })
  }
  return uploads
}

async function sessionUploadBytes(sessionRoot: string) {
  const uploadRoot = resolve(sessionRoot, "uploads")
  let total = 0
  const files: UiFileSummary[] = []
  await walkSessionFiles(uploadRoot, ".", files, 10_000)
  for (const file of files) total += file.size
  return total
}

async function listSessionFiles(session: SessionRecord) {
  const files: UiFileSummary[] = []
  await walkSessionFiles(session.cwd, ".", files, 200)
  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

async function walkSessionFiles(root: string, current: string, files: UiFileSummary[], limit: number) {
  if (files.length >= limit) return
  let entries
  try {
    entries = await readdir(resolve(root, current), { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === "ENOENT") return
    throw error
  }
  for (const entry of entries) {
    if (files.length >= limit) return
    if (entry.name.startsWith(".") && entry.name !== ".pixiu") continue
    const child = current === "." ? entry.name : join(current, entry.name)
    const absolute = resolve(root, child)
    if (entry.isDirectory()) {
      await walkSessionFiles(root, child, files, limit)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(absolute)
    files.push({
      path: relative(root, absolute),
      size: info.size,
      updatedAt: info.mtime.toISOString(),
      kind: isTextLikePath(entry.name) ? "text" : "binary",
    })
  }
}

async function readSessionFileContent(session: SessionRecord, path: string) {
  if (!path.trim()) throw new PixiuError("path is required", { code: "FILE_PATH_REQUIRED" })
  const guard = new PathGuard({ workspaceRoot: session.cwd, workspaceOnly: true })
  const target = guard.resolvePath(path)
  const info = await stat(target.absolutePath)
  if (info.size > 512 * 1024) throw new PixiuError("File is too large to preview.", { code: "FILE_TOO_LARGE" })
  if (!isTextLikePath(target.relativePath)) throw new PixiuError("Only text files can be previewed.", { code: "FILE_NOT_TEXT" })
  return {
    path: target.relativePath,
    size: info.size,
    updatedAt: info.mtime.toISOString(),
    content: await readFile(target.absolutePath, "utf8"),
  }
}

function safeUploadName(value: string) {
  const name = basename(value).replace(/[^\w.\- ]+/g, "_").trim()
  return name || `upload-${Date.now()}`
}

function isTextLikePath(path: string) {
  return /\.(txt|md|markdown|json|jsonc|csv|ts|tsx|js|jsx|py|html|css|log|yaml|yml|xml)$/i.test(path)
}

function renderIndexHtml(token: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pixiu</title>
    <link rel="stylesheet" href="/assets/client.css" />
  </head>
  <body>
    <div id="root"></div>
    <script>window.__PIXIU_UI_TOKEN__ = ${JSON.stringify(token)};</script>
    <script type="module" src="/assets/client.js"></script>
  </body>
</html>`
}

async function ensureClientBundle() {
  if (clientBuildPromise) return clientBuildPromise
  clientBuildPromise = ensureClientBundleUncached().catch((error) => {
    clientBuildPromise = undefined
    throw error
  })
  return clientBuildPromise
}

async function ensureClientBundleUncached() {
  if (await clientBundleIsFresh()) {
    return
  }
  const built = await Bun.build({
    entrypoints: [CLIENT_ENTRY],
    outdir: CLIENT_DIST_DIR,
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "external",
  })
  if (!built.success) {
    throw new PixiuError(`Failed to build UI client: ${built.logs.map((log) => log.message).join("; ")}`, {
      code: "UI_CLIENT_BUILD_FAILED",
    })
  }
}

async function clientBundleIsFresh() {
  try {
    const [bundle, css] = await Promise.all([stat(CLIENT_BUNDLE), stat(CLIENT_CSS)])
    const outputMtime = Math.min(bundle.mtimeMs, css.mtimeMs)
    const sourceMtime = await newestClientSourceMtime(CLIENT_SOURCE_DIR)
    return outputMtime >= sourceMtime
  } catch {
    return false
  }
}

async function newestClientSourceMtime(dir: string): Promise<number> {
  let newest = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (absolute === CLIENT_DIST_DIR) continue
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestClientSourceMtime(absolute))
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(css|ts|tsx|js|jsx)$/i.test(entry.name)) continue
    const info = await stat(absolute)
    newest = Math.max(newest, info.mtimeMs)
  }
  return newest
}

async function clientBundleResponse() {
  await ensureClientBundle()
  return new Response(await readFile(CLIENT_BUNDLE), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

async function clientCssResponse() {
  await ensureClientBundle()
  return new Response(await readFile(CLIENT_CSS), {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function htmlResponse(body: string) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function createLocalToken() {
  return randomBytes(24).toString("base64url")
}

function assertHostAllowed(host: string, allowPublicHost: boolean) {
  if (isLoopbackHost(host)) return
  if (allowPublicHost && host === "0.0.0.0") return
  throw new PixiuError(`Refusing to start UI on non-loopback host ${host}. Local UI must bind to 127.0.0.1 for now.`, {
    code: "UI_HOST_NOT_ALLOWED",
  })
}

function isLoopbackHost(host: string) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1"
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (!value || typeof value !== "object") return value
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    next[key] = isSecretConfigKey(key) ? "[redacted]" : redactConfig(item)
  }
  return next
}

function isSecretConfigKey(key: string) {
  return /^(apiKey|api_key|key|secret|password|accessToken|refreshToken|authToken|bearerToken)$/i.test(key)
}

function errorCode(error: unknown) {
  if (error instanceof PixiuError) return error.code
  return "UI_SERVER_ERROR"
}

function statusForError(error: unknown) {
  if (error instanceof PixiuError && error.code === "UI_HOST_NOT_ALLOWED") return 400
  if (
    error instanceof PixiuError &&
    [
      "UI_JSON_INVALID",
      "UI_CONFIG_INVALID",
      "UI_PERMISSION_INVALID",
      "UI_RUN_INVALID",
      "FILE_PATH_REQUIRED",
      "FILE_TOO_LARGE",
      "FILE_NOT_TEXT",
      "PATH_OUTSIDE_WORKSPACE",
      "UPLOAD_TOO_LARGE",
      "PROVIDER_API_KEY_MISSING",
    ].includes(error.code)
  ) {
    return 400
  }
  return 500
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function uiSessionsRoot(cwd: string) {
  return join(cwd, ".pixiu/state/sessions")
}

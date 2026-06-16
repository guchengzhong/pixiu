import { randomBytes } from "node:crypto"
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

import { approximateTokens } from "../../agent/compaction"
import type { PixiuConfig } from "../../config/defaults"
import { resolveProviderConfig } from "../../config/loader"
import { OpenAICompatibleClient } from "../../llm/openai"
import { buildRuntime, type Runtime, type RuntimeWithoutLLM } from "../../runtime/build"
import { formatError, PixiuError } from "../../shared/errors"
import { readJsoncFile } from "../../shared/json"
import type { JsonValue } from "../../shared/json"
import type { SessionRecord } from "../../session/types"
import { collectSessionEvidence } from "../../session/evidence"
import { apiFailure, apiSuccess, type ApiFailure, type UiConfigResponse, type UiProviderSummary, type UiSessionSummary, type UiStatus } from "../shared/api"
import type { PermissionDecision, PermissionMode, PermissionRequest } from "../../permission/types"
import type { AgentEvent } from "../../agent/events"
import { PathGuard } from "../../sandbox/path"
import { createID } from "../../shared/id"
import { redactSecrets } from "../../shared/redact"
import { inspectMCPServers } from "../../mcp/status"

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
}

type UiFileSummary = {
  path: string
  size: number
  updatedAt: string
  kind: "text" | "binary"
}

type Server = ReturnType<typeof Bun.serve>

type UiRunStatus = "queued" | "running" | "waiting_permission" | "done" | "error" | "cancelled"

type UiRunRecord = {
  id: string
  input: {
    message: string
    sessionId?: string
    permissionMode: PermissionMode
  }
  status: UiRunStatus
  events: AgentEvent[]
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
  status: UiRunStatus
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

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const runtime = await runtimeFor(context)
    const sessions = await runtime.sessions.listSessions()
    return jsonResponse(apiSuccess({ sessions: sessions.map(sessionSummary) }))
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const input = await readJsonBody<SessionCreateInput>(request)
    const runtime = await runtimeFor(context)
    const session = await createUiSession(runtime, input)
    return jsonResponse(apiSuccess({ session: sessionSummary(session), files: await listSessionFiles(session) }))
  }

  const sessionUploadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/uploads$/)
  if (request.method === "POST" && sessionUploadMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionUploadMatch[1] ?? ""))
    const files = await uploadSessionFiles(session, request)
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
    const messages = await runtime.sessions.readMessages(session.id)
    return jsonResponse(apiSuccess({
      session: sessionSummary(session),
      messages,
      evidence: collectSessionEvidence(messages),
      files: await listSessionFiles(session),
      todos: await runtime.sessions.getTodos(session.id),
    }))
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
    events: [],
    controller: new AbortController(),
    answer: "",
    finishReason: "",
    subscribers: new Set(),
    permissions: new Map(),
    done: Promise.resolve(undefined as never),
  }
  run.done = executeRun(context, run)
  context.runs.set(run.id, run)
  emitRunEvent(run, "run", { runId: run.id, status: run.status })
  return run
}

async function executeRun(context: UiServerContext, run: UiRunRecord): Promise<UiRunResult> {
  let runtime: Runtime | undefined
  try {
    run.status = "running"
    emitRunEvent(run, "run", { runId: run.id, status: run.status })
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
      if (event.type === "finish") {
        run.finishReason = event.reason
        run.sessionId = event.sessionId
      }
      emitRunEvent(run, "agent_event", redactForUi(event))
    }
    if (run.controller.signal.aborted) {
      run.status = "cancelled"
      if (!run.finishReason) run.finishReason = "cancelled"
    } else {
      run.status = run.finishReason === "error" ? "error" : "done"
    }
  } catch (error) {
    run.status = run.controller.signal.aborted ? "cancelled" : "error"
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
    status: run.status,
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
    run.status = "waiting_permission"
    emitRunEvent(run, "run", { runId: run.id, status: run.status })
    const pending: UiPendingPermission = {
      id: createPermissionId(),
      request,
      decision,
      resolve,
    }
    run.permissions.set(pending.id, pending)
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
    if (run.status === "waiting_permission") {
      run.status = "running"
      emitRunEvent(run, "run", { runId: run.id, status: run.status })
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
    { event: "run", data: { runId: run.id, status: run.status } },
    ...run.events.map((data) => ({ event: "agent_event", data })),
  ]
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
  return run.status === "done" || run.status === "error" || run.status === "cancelled"
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

function sessionSummary(session: SessionRecord): UiSessionSummary {
  const metadata = session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? session.metadata : {}
  const workspaceDir = typeof metadata.workspaceDir === "string" ? metadata.workspaceDir : undefined
  const model = typeof metadata.model === "string" ? metadata.model : undefined
  const finishStatus = typeof metadata.finishStatus === "string" ? metadata.finishStatus : undefined
  return {
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.title ? { title: session.title } : {}),
    ...(model ? { model } : {}),
    ...(finishStatus ? { finishStatus } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    summaryApproxTokens: session.summary ? approximateTokens(session.summary) : 0,
  }
}

async function updateUiSessionRunMetadata(runtime: Runtime, run: UiRunRecord) {
  if (!run.sessionId) return
  const session = await runtime.sessions.getSession(run.sessionId)
  const metadata = session?.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? session.metadata : {}
  await runtime.sessions.updateSession(run.sessionId, {
    metadata: {
      ...metadata,
      model: providerSummary(runtime.config).model,
      finishStatus: run.status,
      finishReason: run.finishReason,
      lastRunId: run.id,
    },
  })
}

async function createUiSession(runtime: RuntimeWithoutLLM, input: SessionCreateInput) {
  const id = createID("session")
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 80) : "New chat"
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
        sandboxMode: "workspace",
        workspaceDir: relative(runtime.cwd, sessionRoot),
        model: providerSummary(runtime.config).model,
        finishStatus: "new",
      },
    })
  }
  return runtime.sessions.create({
    id,
    cwd: runtime.cwd,
    title,
    metadata: {
      sandboxMode: runtime.config.sandbox.mode,
      workspaceDir: ".",
      model: providerSummary(runtime.config).model,
      finishStatus: "new",
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

import { randomBytes } from "node:crypto"
import { access, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

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
import type { ProjectRecord, SessionFileReference, SessionMessage, SessionRecord } from "../../session/types"
import { DEFAULT_PROJECT_ID } from "../../session/projects"
import { collectSessionEvidence } from "../../session/evidence"
import {
  apiFailure,
  apiSuccess,
  type ApiFailure,
  type UiConfigResponse,
  type UiProjectSummary,
  type UiPromptFileReference,
  type UiProviderSummary,
  type UiSessionSummary,
  type UiStatus,
  type UiWorkspaceChangedFile,
  type UiWorkspaceChangeStatus,
  type UiWorkspaceDiff,
  type UiWorkspaceEntry,
  type UiWorkspaceGitSummary,
  type UiWorkspaceSnapshot,
  type UiChangeSetDiff,
  type UiChangeMutationResult,
  type UiChangeOperation,
  type UiChangeSelection,
  type UiChangeSetSnapshot,
  type UiValidationRecord,
} from "../shared/api"
import type { PermissionDecision, PermissionMode, PermissionRequest } from "../../permission/types"
import type { AgentEvent } from "../../agent/events"
import { PathGuard, isInside } from "../../sandbox/path"
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
import {
  createSessionWorkspaceBinding,
  loadSessionWorkspaceBinding,
  resolveSessionWorkspaceStateRoot,
  sessionWorkspaceProjectExcludePaths,
  type SessionWorkspaceBinding,
} from "../../workspace/session"
import {
  structuredWorkspaceDiff,
  type StructuredWorkspaceDiff,
  type StructuredWorkspaceFileDiff,
  type WorkspaceDiffHunk,
} from "../../workspace/diff"
import { createWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from "../../workspace/checkpoint"
import {
  applySessionWorkspaceChanges,
  assertSessionWorkspaceSelectionsApplied,
  discardSessionWorkspaceChanges,
  readSessionWorkspaceApplyState,
  undoLastSessionWorkspaceApply,
  type SessionWorkspaceChangeOperation,
} from "../../workspace/apply"
import {
  listWorkspaceValidationRecords,
  runWorkspaceValidation,
  type WorkspaceValidationRecord,
} from "../../workspace/validation"

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
// Interval for SSE keepalive comment lines. Kept well under the socket idleTimeout and
// common proxy/browser idle windows so a run that is silent (e.g. a long tool call) does
// not get its event stream dropped.
const SSE_HEARTBEAT_MS = 15_000
const MAX_WORKSPACE_ENTRIES = 2_000
const MAX_WORKSPACE_PREVIEW_BYTES = 512 * 1024
const MAX_PROMPT_REFERENCE_BYTES = 512 * 1024
const MAX_PROMPT_REFERENCES = 20
const MAX_GIT_STATUS_BYTES = 2 * 1024 * 1024
const MAX_GIT_DIFF_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 8_000
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
  // Per-session tail promise: runs on the same session execute strictly serially so they
  // never interleave writes into the same session jsonl. Concurrent writes corrupt the
  // message sequence (duplicate/orphaned tool_calls) and make subsequent LLM requests
  // structurally illegal, which the provider rejects wholesale.
  sessionRunTail: Map<string, Promise<unknown>>
  workspaceMutations: Map<string, Promise<void>>
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
  model?: unknown
  retryOf?: unknown
  references?: unknown
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

type ChangeMutationInput = {
  revision?: unknown
  selections?: unknown
}

type ChangeCommitInput = {
  revision?: unknown
  message?: unknown
}

type ValidationInput = {
  turnId?: unknown
  kind?: unknown
  command?: unknown
  confirmed?: unknown
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
  turnId: string
  input: {
    message: string
    sessionId?: string
    permissionMode: PermissionMode
    model?: string
    retryOf?: string
    references: UiPromptFileReference[]
  }
  status: RunStatus
  statusEvents: RunStatusEvent[]
  streamEvents: UiStreamEvent[]
  nextEventId: number
  activity: ActivityItem[]
  events: AgentEvent[]
  toolCalls: Map<string, Extract<AgentEvent, { type: "tool_call" }>>
  controller: AbortController
  answer: string
  finishReason: string
  model?: string
  startedAt: string
  completedAt?: string
  estimatedInputTokens: number
  providerInputTokens: number
  providerOutputTokens: number
  providerUsageSeen: boolean
  retryCount: number
  checkpointId?: string
  sessionId?: string
  error?: string
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>
  permissions: Map<string, UiPendingPermission>
  done: Promise<UiRunResult>
}

type UiStreamEvent = {
  id: number
  event: string
  data: unknown
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
    sessionRunTail: new Map(),
    workspaceMutations: new Map(),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }
  let server: Server
  try {
    server = Bun.serve({
      hostname: host,
      port,
      // SSE run streams can stay open with no data during long tool calls; raise the
      // socket idle timeout to Bun's max so the connection is not dropped mid-run.
      // The per-stream heartbeat in streamRunEvents keeps traffic flowing under this.
      idleTimeout: 255,
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
    sessionRunTail: new Map(),
    workspaceMutations: new Map(),
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

  if (request.method === "GET" && url.pathname === "/api/fs/list") {
    return jsonResponse(apiSuccess(await listLocalDirectory(url.searchParams.get("path") ?? undefined)))
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

  if (request.method === "GET" && url.pathname === "/api/workspace") {
    const runtime = await runtimeFor(context)
    const project = await workspaceProject(runtime, url.searchParams.get("projectId"))
    return jsonResponse(apiSuccess(await workspaceSnapshot(
      project,
      sessionWorkspaceProjectExcludePaths(runtime.config.sandbox.workspaceDir),
    )))
  }

  if (request.method === "GET" && url.pathname === "/api/workspace/content") {
    const runtime = await runtimeFor(context)
    const project = await workspaceProject(runtime, url.searchParams.get("projectId"))
    return jsonResponse(apiSuccess(await readWorkspaceFileContent(project.rootPath, url.searchParams.get("path") ?? "")))
  }

  if (request.method === "GET" && url.pathname === "/api/workspace/diff") {
    const runtime = await runtimeFor(context)
    const project = await workspaceProject(runtime, url.searchParams.get("projectId"))
    return jsonResponse(apiSuccess(await workspaceFileDiff(project.rootPath, url.searchParams.get("path") ?? "")))
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
    if (typeof input.rootPath === "string") await assertValidProjectRoot(runtime.cwd, input.rootPath)
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
    if (typeof input.rootPath === "string") await assertValidProjectRoot(runtime.cwd, input.rootPath)
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

  const sessionChangesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes$/)
  if (request.method === "GET" && sessionChangesMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionChangesMatch[1] ?? ""))
    return jsonResponse(apiSuccess(await sessionChangeSet(runtime, session)))
  }

  const sessionChangeDiffMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes\/diff$/)
  if (request.method === "GET" && sessionChangeDiffMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionChangeDiffMatch[1] ?? ""))
    return jsonResponse(apiSuccess(await sessionChangeDiff(runtime, session, url.searchParams.get("path") ?? "")))
  }

  const sessionChangeMutationMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes\/(apply|discard)$/)
  if (request.method === "POST" && sessionChangeMutationMatch) {
    const runtime = await runtimeFor(context)
    const sessionId = decodeURIComponent(sessionChangeMutationMatch[1] ?? "")
    assertSessionHasNoActiveRun(context, sessionId)
    const session = await requireSession(runtime, sessionId)
    const binding = await requireBoundWorkspace(runtime, session)
    const input = await readJsonBody<ChangeMutationInput>(request)
    const revision = changeRevision(input.revision)
    const selections = changeSelections(input.selections)
    return await withWorkspaceMutation(context, binding.projectRoot, async () => {
      const result = sessionChangeMutationMatch[2] === "apply"
        ? await applySessionWorkspaceChanges(binding, { revision, selections })
        : await discardSessionWorkspaceChanges(binding, { revision, selections })
      return jsonResponse(apiSuccess({
        operation: uiChangeOperation(result.operation),
        changes: await sessionChangeSet(runtime, session),
      } satisfies UiChangeMutationResult))
    })
  }

  const sessionChangeUndoMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes\/undo$/)
  if (request.method === "POST" && sessionChangeUndoMatch) {
    const runtime = await runtimeFor(context)
    const sessionId = decodeURIComponent(sessionChangeUndoMatch[1] ?? "")
    assertSessionHasNoActiveRun(context, sessionId)
    const session = await requireSession(runtime, sessionId)
    const binding = await requireBoundWorkspace(runtime, session)
    const input = await readJsonBody<ChangeMutationInput>(request)
    const revision = changeRevision(input.revision)
    return await withWorkspaceMutation(context, binding.projectRoot, async () => {
      const result = await undoLastSessionWorkspaceApply(binding, { revision })
      return jsonResponse(apiSuccess({
        operation: uiChangeOperation(result.operation),
        changes: await sessionChangeSet(runtime, session),
      } satisfies UiChangeMutationResult))
    })
  }

  const sessionStageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes\/(stage|unstage)$/)
  if (request.method === "POST" && sessionStageMatch) {
    const runtime = await runtimeFor(context)
    const sessionId = decodeURIComponent(sessionStageMatch[1] ?? "")
    assertSessionHasNoActiveRun(context, sessionId)
    const session = await requireSession(runtime, sessionId)
    const binding = await requireBoundWorkspace(runtime, session)
    const input = await readJsonBody<ChangeMutationInput>(request)
    const revision = changeRevision(input.revision)
    const selections = changeSelections(input.selections)
    return await withWorkspaceMutation(context, binding.projectRoot, async () => {
      const operation = await mutateGitStage(binding, revision, selections, sessionStageMatch[2] === "stage" ? "stage" : "unstage")
      return jsonResponse(apiSuccess({
        operation,
        changes: await sessionChangeSet(runtime, session),
      } satisfies UiChangeMutationResult))
    })
  }

  const sessionCommitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes\/commit$/)
  if (request.method === "POST" && sessionCommitMatch) {
    const runtime = await runtimeFor(context)
    const sessionId = decodeURIComponent(sessionCommitMatch[1] ?? "")
    assertSessionHasNoActiveRun(context, sessionId)
    const session = await requireSession(runtime, sessionId)
    const binding = await requireBoundWorkspace(runtime, session)
    const input = await readJsonBody<ChangeCommitInput>(request)
    const revision = changeRevision(input.revision)
    const message = commitMessage(input.message)
    return await withWorkspaceMutation(context, binding.projectRoot, async () => {
      const operation = await commitSessionChanges(binding, revision, message)
      return jsonResponse(apiSuccess({
        operation,
        changes: await sessionChangeSet(runtime, session),
      } satisfies UiChangeMutationResult))
    })
  }

  const sessionValidationsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/validations$/)
  if (request.method === "GET" && sessionValidationsMatch) {
    const runtime = await runtimeFor(context)
    const session = await requireSession(runtime, decodeURIComponent(sessionValidationsMatch[1] ?? ""))
    return jsonResponse(apiSuccess({ validations: await sessionValidations(runtime, session) }))
  }
  if (request.method === "POST" && sessionValidationsMatch) {
    const runtime = await runtimeFor(context)
    const sessionId = decodeURIComponent(sessionValidationsMatch[1] ?? "")
    assertSessionHasNoActiveRun(context, sessionId)
    const session = await requireSession(runtime, sessionId)
    const binding = await requireBoundWorkspace(runtime, session)
    const input = await readJsonBody<ValidationInput>(request)
    const turnId = validationTurnId(input.turnId)
    const turn = (await runtime.sessions.readTurns(sessionId)).find((item) => item.id === turnId)
    if (!turn) throw new PixiuError(`Unknown turn: ${turnId}`, { code: "TURN_NOT_FOUND" })
    if (input.kind === "custom" && input.confirmed !== true) {
      throw new PixiuError("Custom validation commands require explicit confirmation.", {
        code: "WORKSPACE_VALIDATION_CONFIRMATION_REQUIRED",
      })
    }
    return await withWorkspaceMutation(context, binding.projectRoot, async () => {
      const diff = await structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot)
      const record = await runWorkspaceValidation(binding, {
        sessionId,
        turnId,
        revision: diff.revision,
        kind: input.kind,
        ...(input.command === undefined ? {} : { command: input.command }),
      }, {
        presets: runtime.config.project.commands,
        timeoutMs: runtime.config.sandbox.shellTimeoutMs,
        outputMaxBytes: runtime.config.sandbox.outputMaxBytes,
        envAllowlist: runtime.config.sandbox.envAllowlist,
        signal: request.signal,
      })
      const current = await structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot)
      return jsonResponse(apiSuccess({
        record: uiValidationRecord(record),
        validations: await sessionValidations(runtime, session),
        currentRevision: current.revision,
      }))
    })
  }

  const turnRollbackMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/rollback$/)
  if (request.method === "POST" && turnRollbackMatch) {
    const runtime = await runtimeFor(context)
    const sessionId = decodeURIComponent(turnRollbackMatch[1] ?? "")
    const turnId = decodeURIComponent(turnRollbackMatch[2] ?? "")
    if ([...context.runs.values()].some((run) => run.sessionId === sessionId && !isRunTerminal(run))) {
      throw new PixiuError("Cannot restore files while this session has an active run.", { code: "SESSION_RUN_ACTIVE" })
    }
    const session = await requireSession(runtime, sessionId)
    const turn = (await runtime.sessions.readTurns(sessionId)).find((item) => item.id === turnId)
    if (!turn) throw new PixiuError(`Unknown turn: ${turnId}`, { code: "TURN_NOT_FOUND" })
    if (!turn.checkpointId) throw new PixiuError("This turn has no workspace checkpoint.", { code: "CHECKPOINT_NOT_FOUND" })
    const binding = await boundWorkspaceForSession(runtime, session)
    if (!binding) throw new PixiuError("Legacy sessions cannot restore workspace checkpoints.", { code: "CHECKPOINT_NOT_FOUND" })
    await restoreWorkspaceCheckpoint(binding, turn.checkpointId)
    return jsonResponse(apiSuccess({ turnId, checkpointId: turn.checkpointId, changes: await sessionChangeSet(runtime, session) }))
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
      turns: await runtime.sessions.readTurns(session.id),
      validations: await sessionValidations(runtime, session),
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
    const currentBinding = await boundWorkspaceForSession(runtime, session)
    let cwd = session.cwd
    let workspaceMetadata: JsonObject = {}
    if (currentBinding && resolve(project.rootPath) !== currentBinding.projectRoot) {
      const [messages, diff] = await Promise.all([
        runtime.sessions.readMessages(session.id),
        structuredWorkspaceDiff(currentBinding.baselineRoot, currentBinding.workRoot),
      ])
      if (messages.length || diff.files.length) {
        throw new PixiuError("A session with conversation history or workspace changes cannot be moved to another project.", {
          code: "SESSION_MOVE_BOUND",
        })
      }
      const nextBinding = await createSessionWorkspaceBinding({
        stateRoot: resolveSessionWorkspaceStateRoot(runtime.config.sandbox.workspaceDir),
        projectRoot: project.rootPath,
        projectId: project.id,
        sessionId: session.id,
        excludePaths: sessionWorkspaceProjectExcludePaths(runtime.config.sandbox.workspaceDir),
      })
      cwd = nextBinding.workRoot
      workspaceMetadata = {
        workspaceDir: nextBinding.workRoot,
        workspaceBindingVersion: nextBinding.version,
        workspaceStateRoot: nextBinding.stateRoot,
        workspaceProjectRoot: nextBinding.projectRoot,
        workspaceBaseRevision: nextBinding.baseRevision,
      }
    }
    const updated = await runtime.sessions.updateSession(session.id, {
      cwd,
      metadata: {
        ...sessionMetadata(session),
        projectId: project.id,
        ...workspaceMetadata,
      },
    })
    const fallbackProjectId = await fallbackProjectIdFor(runtime)
    return jsonResponse(apiSuccess({ session: await sessionSummary(updated, fallbackProjectId) }))
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    const input = await readJsonBody<RunInput>(request)
    const run = startAgentRun(context, input)
    if (url.searchParams.get("wait") === "1") return jsonResponse(apiSuccess(await run.done))
    return jsonResponse(apiSuccess({ runId: run.id, turnId: run.turnId, status: run.status }))
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (request.method === "GET" && runMatch) {
    const run = context.runs.get(decodeURIComponent(runMatch[1] ?? ""))
    return jsonResponse(apiSuccess(run ? { found: true, status: run.status } : { found: false }))
  }

  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (request.method === "GET" && runEventsMatch) {
    const run = context.runs.get(decodeURIComponent(runEventsMatch[1] ?? ""))
    if (!run) return jsonResponse(apiFailure("RUN_NOT_FOUND", "Unknown run."), 404)
    return streamRunEvents(run, request.signal, request.headers.get("last-event-id"))
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

function changeRevision(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new PixiuError("A current workspace revision is required.", { code: "WORKSPACE_CHANGE_REQUEST_INVALID" })
  }
  return value
}

function changeSelections(value: unknown): UiChangeSelection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) {
    throw new PixiuError("At least one workspace file or hunk must be selected.", {
      code: "WORKSPACE_CHANGE_REQUEST_INVALID",
    })
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PixiuError("Workspace change selections must be objects.", {
        code: "WORKSPACE_CHANGE_REQUEST_INVALID",
      })
    }
    const input = item as Record<string, unknown>
    const path = typeof input.path === "string" ? input.path.trim() : ""
    if (!path || path.length > 1_000) {
      throw new PixiuError("Each workspace change selection requires a path.", {
        code: "WORKSPACE_CHANGE_REQUEST_INVALID",
      })
    }
    if (input.hunkIds === undefined) return { path }
    if (!Array.isArray(input.hunkIds) || input.hunkIds.length === 0 || input.hunkIds.some((id) => typeof id !== "string")) {
      throw new PixiuError("hunkIds must contain selected workspace hunk ids.", {
        code: "WORKSPACE_CHANGE_REQUEST_INVALID",
      })
    }
    return { path, hunkIds: [...input.hunkIds] as string[] }
  })
}

function commitMessage(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || value.includes("\0")) {
    throw new PixiuError("Commit message must be between 1 and 4096 characters.", {
      code: "WORKSPACE_COMMIT_MESSAGE_INVALID",
    })
  }
  return value.trim()
}

function parsePromptReferences(value: unknown): UiPromptFileReference[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new PixiuError("references must be an array", { code: "UI_RUN_INVALID" })
  if (value.length > MAX_PROMPT_REFERENCES) {
    throw new PixiuError(`A prompt can reference at most ${MAX_PROMPT_REFERENCES} files.`, { code: "UI_RUN_INVALID" })
  }
  const sources = new Set<UiPromptFileReference["source"]>(["uploaded", "workspace", "generated", "evidence"])
  const result: UiPromptFileReference[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PixiuError("Each file reference must be an object.", { code: "UI_RUN_INVALID" })
    }
    const input = item as Record<string, unknown>
    const path = typeof input.path === "string" ? input.path.trim() : ""
    const source = typeof input.source === "string" && sources.has(input.source as UiPromptFileReference["source"])
      ? input.source as UiPromptFileReference["source"]
      : undefined
    if (!path || path.length > 1_000 || !source) {
      throw new PixiuError("Each file reference requires a valid path and source.", { code: "UI_RUN_INVALID" })
    }
    const startLine = optionalPositiveInteger(input.startLine, "startLine")
    const endLine = optionalPositiveInteger(input.endLine, "endLine")
    if (endLine !== undefined && startLine === undefined) {
      throw new PixiuError("endLine requires startLine.", { code: "UI_RUN_INVALID" })
    }
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      throw new PixiuError("endLine must be greater than or equal to startLine.", { code: "UI_RUN_INVALID" })
    }
    const key = `${source}:${path}:${startLine ?? ""}:${endLine ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ path, source, ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) })
  }
  return result
}

function optionalPositiveInteger(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new PixiuError(`${name} must be a positive integer.`, { code: "UI_RUN_INVALID" })
  }
  return Number(value)
}

async function resolvePromptReferences(
  runtime: Runtime,
  sessionId: string,
  references: UiPromptFileReference[],
): Promise<SessionFileReference[]> {
  if (!references.length) return []
  const session = await requireSession(runtime, sessionId)
  const resolved: SessionFileReference[] = []
  let totalBytes = 0
  for (const reference of references) {
    const file = await readWorkspaceFileContent(session.cwd, reference.path)
    const lines = file.content.split(/\r?\n/)
    let content = file.content
    if (reference.startLine !== undefined) {
      const endLine = reference.endLine ?? reference.startLine
      if (reference.startLine > lines.length || endLine > lines.length) {
        throw new PixiuError(`Line range is outside ${reference.path} (${lines.length} lines).`, { code: "FILE_RANGE_INVALID" })
      }
      content = lines.slice(reference.startLine - 1, endLine).join("\n")
    }
    totalBytes += Buffer.byteLength(content)
    if (totalBytes > MAX_PROMPT_REFERENCE_BYTES) {
      throw new PixiuError("Referenced file contents exceed the 512 KB prompt limit.", { code: "FILE_REFERENCES_TOO_LARGE" })
    }
    resolved.push({
      path: file.path,
      content,
      source: reference.source,
      ...(reference.startLine !== undefined ? { startLine: reference.startLine } : {}),
      ...(reference.endLine !== undefined ? { endLine: reference.endLine } : {}),
    })
  }
  return resolved
}

function startAgentRun(context: UiServerContext, input: RunInput) {
  const message = typeof input.message === "string" ? input.message.trim() : ""
  const references = parsePromptReferences(input.references)
  if (!message && !references.length) throw new PixiuError("message or references are required", { code: "UI_RUN_INVALID" })
  const permissionMode = parsePermissionMode(typeof input.permissionMode === "string" ? input.permissionMode : undefined)
  const sessionId = typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : undefined
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim().slice(0, 200) : undefined
  const retryOf = typeof input.retryOf === "string" && input.retryOf.trim() ? input.retryOf.trim() : undefined
  const startedAt = new Date().toISOString()
  const run: UiRunRecord = {
    id: createRunId(),
    turnId: createID("turn"),
    input: {
      message,
      permissionMode,
      ...(sessionId ? { sessionId } : {}),
      ...(model ? { model } : {}),
      ...(retryOf ? { retryOf } : {}),
      references,
    },
    status: "queued",
    statusEvents: [],
    streamEvents: [],
    nextEventId: 1,
    activity: [],
    events: [],
    toolCalls: new Map(),
    controller: new AbortController(),
    answer: "",
    finishReason: "",
    startedAt,
    estimatedInputTokens: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    providerUsageSeen: false,
    retryCount: 0,
    subscribers: new Set(),
    permissions: new Map(),
    done: Promise.resolve(undefined as never),
  }
  context.runs.set(run.id, run)
  setRunStatus(run, "queued", { message: "Run queued.", phase: "starting" })
  if (sessionId) {
    // Abort any in-flight run on this session and chain execution after the previous
    // run on the same session fully settles, so runs never write the session jsonl
    // concurrently.
    for (const other of context.runs.values()) {
      if (other !== run && other.input.sessionId === sessionId && !isRunTerminal(other)) {
        other.controller.abort()
        denyPendingPermissions(other, "superseded by a newer run on this session")
      }
    }
    const previousTail = context.sessionRunTail.get(sessionId)
    run.done = Promise.resolve(previousTail)
      .catch(() => undefined)
      .then(() => executeRun(context, run))
    context.sessionRunTail.set(sessionId, run.done.catch(() => undefined))
  } else {
    run.done = Promise.resolve().then(() => executeRun(context, run))
  }
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
      ...(run.input.model ? { model: run.input.model } : {}),
    })
    run.model = run.input.model ?? providerSummary(runtime.config).model
    const references = run.input.sessionId
      ? await resolvePromptReferences(runtime, run.input.sessionId, run.input.references)
      : []
    for await (const event of runtime.runner.run(
      run.input.sessionId
        ? { message: run.input.message, sessionId: run.input.sessionId, turnId: run.turnId, references, signal: run.controller.signal }
        : { message: run.input.message, turnId: run.turnId, references, signal: run.controller.signal },
    )) {
      run.events.push(event)
      if (event.type === "llm_text_delta") run.answer += event.text
      if (event.type === "message") run.answer = event.content
      if (event.type === "session_created") {
        run.sessionId = event.sessionId
        await createPersistedTurn(runtime, run)
      }
      if (event.type === "context_usage") {
        if (event.source === "provider") {
          run.providerUsageSeen = true
          run.providerInputTokens += event.inputTokens
          run.providerOutputTokens += event.outputTokens ?? 0
        } else {
          run.estimatedInputTokens += event.inputTokens
        }
      }
      if (event.type === "tool_call") {
        run.toolCalls.set(event.id, event)
        emitToolIntentActivity(run, event)
      }
      if (event.type === "tool_result") emitToolActivity(run, event)
      if (event.type === "error") run.error = event.message
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
    run.completedAt = new Date().toISOString()
    if (runtime && run.sessionId) await finalizePersistedTurn(runtime, run).catch(() => undefined)
    if (runtime && run.sessionId) await updateUiSessionRunMetadata(runtime, run).catch(() => undefined)
    await runtime?.close()
    const result = runResult(run)
    emitRunEvent(run, "result", result)
    closeRunSubscribers(run)
  }
  return runResult(run)
}

function runResult(run: UiRunRecord): UiRunResult {
  const inputTokens = run.providerUsageSeen ? run.providerInputTokens : run.estimatedInputTokens
  const durationMs = run.completedAt ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)) : undefined
  return redactForUi({
    runId: run.id,
    turnId: run.turnId,
    status: terminalRunStatus(run.status),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.model ? { model: run.model } : {}),
    startedAt: run.startedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(run.providerUsageSeen ? { outputTokens: run.providerOutputTokens } : {}),
    retryCount: run.retryCount,
    ...(run.input.retryOf ? { retryOf: run.input.retryOf } : {}),
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

function streamRunEvents(run: UiRunRecord, signal?: AbortSignal, lastEventId?: string | null) {
  const encoder = new TextEncoder()
  const cursor = parseLastEventId(lastEventId)
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      for (const event of run.streamEvents) {
        if (event.id <= cursor) continue
        controller.enqueue(encoder.encode(formatSSE(event.event, event.data, event.id)))
      }
      if (isRunTerminal(run) && run.streamEvents.some((event) => event.event === "result")) {
        controller.close()
        return
      }
      run.subscribers.add(controller)
      // Keepalive: emit an SSE comment line periodically so the connection stays alive
      // during long silent periods. Self-clears if the stream is already closed.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"))
        } catch {
          clearInterval(heartbeat)
        }
      }, SSE_HEARTBEAT_MS)
      const cleanup = () => {
        clearInterval(heartbeat)
        run.subscribers.delete(controller)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
      heartbeatTimer = heartbeat
      signal?.addEventListener("abort", cleanup, { once: true })
    },
    cancel() {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
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

function parseLastEventId(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) return 0
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function replayRunEvents(run: UiRunRecord) {
  return [
    ...run.statusEvents.map((data) => ({ event: "run_status", data })),
    { event: "run", data: legacyRunEventData(run) },
    ...(run.activity.length
      ? [{ event: "activity_updated", data: activityUpdatedEvent(run, run.activity.at(-1)) }]
      : []),
    ...run.events.map((data) => ({ event: "agent_event", data })),
    ...[...run.permissions.values()].map((pending) => ({
      event: "permission_request",
      data: redactForUi({
        id: pending.id,
        runId: run.id,
        request: pending.request,
        decision: pending.decision,
        similarityKey: permissionSimilarityKey(pending.request, pending.decision),
      }),
    })),
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
  const stored = { id: run.nextEventId, event, data } satisfies UiStreamEvent
  run.nextEventId += 1
  run.streamEvents.push(stored)
  const chunk = new TextEncoder().encode(formatSSE(event, redactForUi(data), stored.id))
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

function formatSSE(event: string, data: unknown, id?: number) {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(redactForUi(data))}\n\n`
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

async function fallbackProjectIdFor(runtime: Pick<RuntimeWithoutLLM, "projects">) {
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

async function createPersistedTurn(runtime: Runtime, run: UiRunRecord) {
  if (!run.sessionId) return
  const turns = await runtime.sessions.readTurns(run.sessionId)
  if (turns.some((turn) => turn.id === run.turnId)) return
  const retryTarget = run.input.retryOf ? turns.find((turn) => turn.id === run.input.retryOf) : undefined
  if (run.input.retryOf && !retryTarget) {
    throw new PixiuError(`Unknown retry turn: ${run.input.retryOf}`, { code: "TURN_NOT_FOUND" })
  }
  run.retryCount = retryTarget ? retryTarget.retryCount + 1 : 0
  await runtime.sessions.createTurn({
    id: run.turnId,
    runId: run.id,
    sessionId: run.sessionId,
    model: run.model ?? providerSummary(runtime.config).model,
    status: run.status,
    startedAt: run.startedAt,
    retryCount: run.retryCount,
    ...(retryTarget ? { retryOf: retryTarget.id } : {}),
  })
  const session = await requireSession(runtime, run.sessionId)
  const binding = await boundWorkspaceForSession(runtime, session)
  if (binding) {
    const checkpoint = await createWorkspaceCheckpoint(binding, run.turnId)
    run.checkpointId = checkpoint.id
    await runtime.sessions.updateTurn(run.sessionId, run.turnId, { checkpointId: checkpoint.id })
  }
}

async function finalizePersistedTurn(runtime: Runtime, run: UiRunRecord) {
  if (!run.sessionId) return
  const turn = (await runtime.sessions.readTurns(run.sessionId)).find((item) => item.id === run.turnId)
  if (!turn) return
  const completedAt = run.completedAt ?? new Date().toISOString()
  const inputTokens = run.providerUsageSeen ? run.providerInputTokens : run.estimatedInputTokens
  await runtime.sessions.updateTurn(run.sessionId, run.turnId, {
    status: terminalRunStatus(run.status),
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(run.startedAt)),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(run.providerUsageSeen ? { outputTokens: run.providerOutputTokens } : {}),
    ...(run.error ? { error: run.error } : {}),
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

// Read-only local directory browser backing the UI folder picker. Lists the subdirectories
// of `path` (default: the server user's home) so the user can navigate and pick a workspace
// root. Local, token-gated, and directory-names only.
async function listLocalDirectory(path?: string) {
  const base = path && path.trim() ? resolve(path.trim()) : homedir()
  let info
  try {
    info = await stat(base)
  } catch {
    throw new PixiuError(`Folder does not exist: ${base}`, { code: "FS_PATH_INVALID" })
  }
  if (!info.isDirectory()) throw new PixiuError(`Not a directory: ${base}`, { code: "FS_PATH_INVALID" })

  const entries: { name: string; path: string }[] = []
  for (const entry of await readdir(base, { withFileTypes: true })) {
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await stat(join(base, entry.name))).isDirectory()
      } catch {
        isDir = false
      }
    }
    if (isDir) entries.push({ name: entry.name, path: join(base, entry.name) })
  }
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))

  const parent = dirname(base)
  return {
    path: base,
    ...(parent !== base ? { parent } : {}),
    entries,
    drives: await windowsDrives(),
    home: homedir(),
  }
}

async function windowsDrives() {
  if (process.platform !== "win32") return [] as string[]
  const drives: string[] = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      await access(root)
      drives.push(root)
    } catch {
      // drive not present
    }
  }
  return drives
}

// Rejects a project rootPath that is not an existing local directory. The chosen folder
// becomes the working directory of every session in the project, so it must be real.
async function assertValidProjectRoot(cwd: string, rootPath: string) {
  const resolved = resolve(cwd, rootPath.trim())
  let info
  try {
    info = await stat(resolved)
  } catch {
    throw new PixiuError(`Workspace root does not exist: ${rootPath}`, { code: "PROJECT_ROOT_INVALID" })
  }
  if (!info.isDirectory()) {
    throw new PixiuError(`Workspace root is not a directory: ${rootPath}`, { code: "PROJECT_ROOT_INVALID" })
  }
}

async function createUiSession(runtime: RuntimeWithoutLLM, input: SessionCreateInput) {
  const id = createID("session")
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 80) : "New chat"
  const projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : (await runtime.projects.current()).id
  const project = await runtime.projects.get(projectId)
  if (!project) throw new PixiuError(`Unknown project: ${projectId}`, { code: "PROJECT_NOT_FOUND" })
  if (runtime.config.sandbox.mode === "workspace") {
    const binding = await createSessionWorkspaceBinding({
      stateRoot: resolveSessionWorkspaceStateRoot(runtime.config.sandbox.workspaceDir),
      projectRoot: project.rootPath,
      projectId: project.id,
      sessionId: id,
      excludePaths: sessionWorkspaceProjectExcludePaths(runtime.config.sandbox.workspaceDir),
    })
    return runtime.sessions.create({
      id,
      cwd: binding.workRoot,
      title,
      metadata: {
        projectId,
        titleSource: "user",
        sandboxMode: "workspace",
        workspaceDir: binding.workRoot,
        workspaceBindingVersion: binding.version,
        workspaceStateRoot: binding.stateRoot,
        workspaceProjectRoot: binding.projectRoot,
        workspaceBaseRevision: binding.baseRevision,
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

async function boundWorkspaceForSession(
  runtime: Pick<RuntimeWithoutLLM, "sessions" | "projects" | "config">,
  session: SessionRecord,
): Promise<SessionWorkspaceBinding | undefined> {
  const metadata = sessionMetadata(session)
  if (metadata.workspaceBindingVersion !== 1) return undefined
  const stateRoot = typeof metadata.workspaceStateRoot === "string" ? metadata.workspaceStateRoot : undefined
  if (!stateRoot) throw new PixiuError("Session workspace metadata is incomplete.", { code: "SESSION_WORKSPACE_META_INVALID" })
  const fallbackProjectId = await fallbackProjectIdFor(runtime)
  const project = await runtime.projects.get(sessionProjectId(session, fallbackProjectId))
  if (!project) throw new PixiuError("The project bound to this session no longer exists.", { code: "PROJECT_NOT_FOUND" })
  const binding = await loadSessionWorkspaceBinding({
    stateRoot,
    projectRoot: project.rootPath,
    sessionId: session.id,
  })
  if (resolve(session.cwd) !== binding.workRoot) {
    throw new PixiuError("Session cwd does not match its workspace binding.", { code: "SESSION_WORKSPACE_META_MISMATCH" })
  }
  return binding
}

async function requireBoundWorkspace(runtime: RuntimeWithoutLLM, session: SessionRecord) {
  const binding = await boundWorkspaceForSession(runtime, session)
  if (!binding) {
    throw new PixiuError("Legacy sessions cannot mutate isolated workspace changes.", {
      code: "SESSION_WORKSPACE_UNAVAILABLE",
    })
  }
  return binding
}

async function sessionValidations(runtime: RuntimeWithoutLLM, session: SessionRecord): Promise<UiValidationRecord[]> {
  const binding = await boundWorkspaceForSession(runtime, session)
  if (!binding) return []
  return (await listWorkspaceValidationRecords(binding))
    .map(uiValidationRecord)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
}

function uiValidationRecord(record: WorkspaceValidationRecord): UiValidationRecord {
  return {
    id: record.id,
    sessionId: record.sessionId,
    turnId: record.turnId,
    revision: record.revision,
    kind: record.kind,
    command: record.command,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
    output: record.output,
    truncated: record.truncated,
    timedOut: record.timedOut,
  }
}

function validationTurnId(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\0\r\n]/.test(value)) {
    throw new PixiuError("Validation turnId is invalid.", { code: "WORKSPACE_VALIDATION_KEY_INVALID" })
  }
  return value.trim()
}

function activeSessionApplies(operations: SessionWorkspaceChangeOperation[]) {
  const undone = new Set(operations.filter((operation) => operation.action === "undo" && operation.applyId).map((operation) => operation.applyId!))
  return operations.filter((operation) => operation.action === "apply" && !undone.has(operation.id))
}

function uiChangeOperation(operation: SessionWorkspaceChangeOperation): UiChangeOperation {
  return {
    id: operation.id,
    action: operation.action,
    paths: [...operation.paths],
    createdAt: operation.createdAt,
    revision: operation.revision,
    selections: operation.selections.map((selection) => selection.hunkIds
      ? { path: selection.path, hunkIds: [...selection.hunkIds] }
      : { path: selection.path }),
  }
}

function assertSessionHasNoActiveRun(context: UiServerContext, sessionId: string) {
  if ([...context.runs.values()].some((run) => run.sessionId === sessionId && !isRunTerminal(run))) {
    throw new PixiuError("Cannot mutate files while this session has an active run.", { code: "SESSION_RUN_ACTIVE" })
  }
}

async function withWorkspaceMutation<T>(
  context: UiServerContext,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = context.workspaceMutations.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent
  })
  const queued = previous.then(() => current)
  context.workspaceMutations.set(key, queued)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (context.workspaceMutations.get(key) === queued) context.workspaceMutations.delete(key)
  }
}

async function sessionChangeSet(runtime: RuntimeWithoutLLM, session: SessionRecord): Promise<UiChangeSetSnapshot> {
  const binding = await boundWorkspaceForSession(runtime, session)
  if (!binding) {
    return {
      available: false,
      sessionId: session.id,
      changes: [],
      canUndo: false,
      message: "This legacy session has no isolated project baseline. Create a new session to review and apply changes.",
    }
  }
  const [diff, git, applyState] = await Promise.all([
    structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot),
    inspectGitWorkspace(binding.projectRoot),
    readSessionWorkspaceApplyState(binding),
  ])
  const stagedPaths = new Set(git.changedFiles.filter((file) => file.indexStatus !== " " && file.indexStatus !== "?").map((file) => file.path))
  const changedProjectPaths = new Set(git.changedFiles.map((file) => file.path))
  const activeApplies = activeSessionApplies(applyState.operations)
  const fallbackProjectId = await fallbackProjectIdFor(runtime)
  return {
    available: true,
    sessionId: session.id,
    projectId: sessionProjectId(session, fallbackProjectId),
    projectRoot: binding.projectRoot,
    createdAt: binding.createdAt,
    baseRevision: diff.baseRevision,
    workRevision: diff.workRevision,
    revision: diff.revision,
    changes: diff.files.map((file) => {
      const applies = activeApplies.filter((operation) => operation.paths.includes(file.path))
      const wholeFileApplied = applies.some((operation) => operation.selections?.some((selection) => (
        selection.path === file.path && selection.hunkIds === undefined
      )))
      const appliedHunkIds = wholeFileApplied
        ? file.hunks.map((hunk) => hunk.id)
        : [...new Set(applies.flatMap((operation) => operation.revision === diff.revision
          ? operation.selections?.find((selection) => selection.path === file.path)?.hunkIds ?? []
          : []))]
      const applied = applies.length > 0
      return {
        path: file.path,
        status: file.status,
        binary: file.binary,
        size: file.newSize ?? file.oldSize ?? 0,
        hunkCount: file.hunks.length,
        additions: file.additions,
        deletions: file.deletions,
        appliedHunkIds,
        applied,
        staged: stagedPaths.has(file.path),
        committed: applied && !changedProjectPaths.has(file.path),
      }
    }),
    canUndo: applyState.canUndo,
  }
}

async function sessionChangeDiff(
  runtime: RuntimeWithoutLLM,
  session: SessionRecord,
  path: string,
): Promise<UiChangeSetDiff> {
  if (!path.trim()) throw new PixiuError("path is required", { code: "FILE_PATH_REQUIRED" })
  const binding = await boundWorkspaceForSession(runtime, session)
  if (!binding) {
    return { path, available: false, binary: false, content: "", hunks: [], truncated: false, message: "Legacy session changes are unavailable." }
  }
  const diff = await structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot)
  const file = diff.files.find((item) => item.path === path)
  if (!file) {
    return { path, available: false, binary: false, content: "", hunks: [], truncated: false, revision: diff.revision, message: "This file has no session changes." }
  }
  const content = workspaceUnifiedDiff(file)
  return {
    path: file.path,
    available: true,
    status: file.status,
    revision: diff.revision,
    binary: file.binary,
    content,
    hunks: file.hunks.map((hunk) => ({
      id: hunk.id,
      header: hunk.header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      content: hunk.patch,
    })),
    truncated: false,
    ...(file.hunksUnavailableReason ? { message: `Line hunks are unavailable for this ${file.hunksUnavailableReason} change.` } : {}),
  }
}

function workspaceUnifiedDiff(file: StructuredWorkspaceFileDiff, hunks: WorkspaceDiffHunk[] = file.hunks) {
  const before = file.status === "added" ? "/dev/null" : `a/${file.path}`
  const after = file.status === "deleted" ? "/dev/null" : `b/${file.path}`
  const headers = [`diff --git a/${file.path} b/${file.path}`, `--- ${before}`, `+++ ${after}`]
  if (file.binary) return [...headers, "Binary files differ"].join("\n")
  return `${[...headers, ...hunks.map((hunk) => hunk.patch.trimEnd())].join("\n")}\n`
}

async function requireSession(runtime: Pick<RuntimeWithoutLLM, "sessions">, sessionId: string) {
  const session = await runtime.sessions.getSession(sessionId)
  if (!session) throw new PixiuError(`Unknown session: ${sessionId}`, { code: "SESSION_NOT_FOUND" })
  return session
}

async function workspaceProject(runtime: RuntimeWithoutLLM, requestedId: string | null) {
  const projectId = requestedId?.trim()
  const project = projectId ? await runtime.projects.get(projectId) : await runtime.projects.current()
  if (!project) throw new PixiuError(`Unknown project: ${projectId ?? "current"}`, { code: "PROJECT_NOT_FOUND" })
  return project
}

async function workspaceSnapshot(project: ProjectRecord, excludedPaths: string[] = []): Promise<UiWorkspaceSnapshot> {
  const rootPath = resolve(project.rootPath)
  try {
    const info = await stat(rootPath)
    if (!info.isDirectory()) {
      return unavailableWorkspaceSnapshot(project, rootPath, "Project root is not a directory.")
    }

    const entries: UiWorkspaceEntry[] = []
    const walkState = { truncated: false }
    await walkWorkspaceFiles(rootPath, ".", entries, walkState, excludedPaths)
    const inspectedGit = await inspectGitWorkspace(rootPath)
    const git = {
      ...inspectedGit,
      changedFiles: inspectedGit.changedFiles.filter((file) => !isConfiguredWorkspacePath(file.path, excludedPaths)),
    }
    const changedByPath = new Map(git.changedFiles.map((file) => [file.path, file.status]))
    const annotatedEntries = entries.map((entry) => {
      const gitStatus = changedByPath.get(entry.path)
      return gitStatus ? { ...entry, gitStatus } : entry
    })
    return {
      available: true,
      projectId: project.id,
      projectName: project.name,
      rootPath,
      entries: annotatedEntries,
      truncated: walkState.truncated,
      git,
    }
  } catch (error: any) {
    if (["ENOENT", "EACCES", "EPERM"].includes(String(error?.code))) {
      return unavailableWorkspaceSnapshot(project, rootPath, "Project root is unavailable or unreadable.")
    }
    throw error
  }
}

function unavailableWorkspaceSnapshot(project: ProjectRecord, rootPath: string, message: string): UiWorkspaceSnapshot {
  return {
    available: false,
    projectId: project.id,
    projectName: project.name,
    rootPath,
    entries: [],
    truncated: false,
    git: gitUnavailable("not_repository", "Git information is unavailable because the project root cannot be read."),
    message,
  }
}

async function walkWorkspaceFiles(
  root: string,
  current: string,
  entries: UiWorkspaceEntry[],
  state: { truncated: boolean },
  excludedPaths: string[],
) {
  if (entries.length >= MAX_WORKSPACE_ENTRIES) {
    state.truncated = true
    return
  }
  let children
  try {
    children = await readdir(resolve(root, current), { withFileTypes: true })
  } catch (error: any) {
    if (["ENOENT", "EACCES", "EPERM"].includes(String(error?.code))) return
    throw error
  }
  children.sort((left, right) => {
    const leftDirectory = left.isDirectory() ? 0 : 1
    const rightDirectory = right.isDirectory() ? 0 : 1
    return leftDirectory - rightDirectory || left.name.localeCompare(right.name)
  })
  for (const child of children) {
    if (entries.length >= MAX_WORKSPACE_ENTRIES) {
      state.truncated = true
      return
    }
    const childPath = current === "." ? child.name : join(current, child.name)
    if ([".git", ".tools", ".venv", "node_modules"].includes(child.name)
      || (current === "." && child.name === ".pixiu")
      || isConfiguredWorkspacePath(childPath, excludedPaths)) continue
    const absolutePath = resolve(root, childPath)
    let info
    try {
      info = await lstat(absolutePath)
    } catch (error: any) {
      if (["ENOENT", "EACCES", "EPERM"].includes(String(error?.code))) continue
      throw error
    }
    const base = {
      path: relative(root, absolutePath),
      name: child.name,
      parentPath: current,
      updatedAt: info.mtime.toISOString(),
    }
    if (info.isSymbolicLink()) {
      entries.push({ ...base, type: "symlink" })
      continue
    }
    if (info.isDirectory()) {
      entries.push({ ...base, type: "directory" })
      await walkWorkspaceFiles(root, childPath, entries, state, excludedPaths)
      continue
    }
    if (!info.isFile()) continue
    entries.push({
      ...base,
      type: "file",
      size: info.size,
      kind: isTextLikePath(child.name) ? "text" : "binary",
    })
  }
}

function isConfiguredWorkspacePath(path: string, excludedPaths: string[]) {
  const normalized = path.split(sep).join("/")
  return excludedPaths.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`))
}

async function readWorkspaceFileContent(rootPath: string, path: string) {
  const target = await resolveWorkspaceTarget(rootPath, path)
  const info = await stat(target.absolutePath)
  if (!info.isFile()) throw new PixiuError("Only files can be previewed.", { code: "WORKSPACE_PATH_NOT_FILE" })
  if (info.size > MAX_WORKSPACE_PREVIEW_BYTES) throw new PixiuError("File is too large to preview.", { code: "FILE_TOO_LARGE" })
  const content = await readFile(target.absolutePath)
  if (content.includes(0)) throw new PixiuError("Only text files can be previewed.", { code: "FILE_NOT_TEXT" })
  return {
    path: target.relativePath,
    size: info.size,
    updatedAt: info.mtime.toISOString(),
    content: content.toString("utf8"),
  }
}

async function resolveWorkspaceTarget(rootPath: string, path: string, options: { allowMissing?: boolean } = {}) {
  if (!path.trim()) throw new PixiuError("path is required", { code: "FILE_PATH_REQUIRED" })
  const root = resolve(rootPath)
  const guard = new PathGuard({ workspaceRoot: root, workspaceOnly: true })
  const target = guard.resolvePath(path)
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
  } catch (cause) {
    throw new PixiuError("Project root is unavailable.", { code: "WORKSPACE_ROOT_UNAVAILABLE", cause })
  }

  try {
    const canonicalTarget = await realpath(target.absolutePath)
    if (!isInside(canonicalRoot, canonicalTarget)) {
      throw new PixiuError(`Path escapes workspace: ${path}`, { code: "PATH_OUTSIDE_WORKSPACE" })
    }
  } catch (error: any) {
    if (error instanceof PixiuError) throw error
    if (error?.code !== "ENOENT" || !options.allowMissing) {
      if (error?.code === "ENOENT") throw new PixiuError(`Unknown workspace file: ${path}`, { code: "WORKSPACE_FILE_NOT_FOUND", cause: error })
      throw error
    }
    const canonicalParent = await nearestExistingParent(dirname(target.absolutePath), root)
    if (!isInside(canonicalRoot, canonicalParent)) {
      throw new PixiuError(`Path escapes workspace: ${path}`, { code: "PATH_OUTSIDE_WORKSPACE" })
    }
  }
  return target
}

async function nearestExistingParent(start: string, root: string) {
  let current = start
  while (isInside(root, current)) {
    try {
      return await realpath(current)
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  throw new PixiuError("Workspace file parent is unavailable.", { code: "WORKSPACE_FILE_NOT_FOUND" })
}

async function mutateGitStage(
  binding: SessionWorkspaceBinding,
  revision: string,
  selections: UiChangeSelection[],
  action: "stage" | "unstage",
): Promise<UiChangeOperation> {
  const diff = await currentSessionChangeDiff(binding, revision)
  const selected = selectedStageChanges(diff, selections)
  const paths = selected.map((item) => item.selection.path)
  const git = await inspectGitWorkspace(binding.projectRoot)
  if (!git.available) {
    throw new PixiuError(git.message ?? "The project is not a Git worktree.", { code: "WORKSPACE_GIT_UNAVAILABLE" })
  }
  const stagedPaths = new Set(git.changedFiles.filter((file) => file.indexStatus !== " " && file.indexStatus !== "?").map((file) => file.path))
  if (action === "stage") {
    await assertSessionWorkspaceSelectionsApplied(binding, { revision, selections })
  } else {
    const notStaged = paths.find((path) => !stagedPaths.has(path))
    if (notStaged) {
      throw new PixiuError(`Workspace file is not staged: ${notStaged}`, { code: "WORKSPACE_CHANGE_NOT_STAGED" })
    }
  }

  const wholeFilePaths = selected.filter((item) => !item.hunks).map((item) => item.selection.path)
  if (wholeFilePaths.length) {
    const result = action === "stage"
      ? await runGit(binding.projectRoot, ["add", "--", ...wholeFilePaths], MAX_GIT_STATUS_BYTES)
      : await unstageGitPaths(binding.projectRoot, wholeFilePaths)
    if (!result.ok) throw gitMutationError(action, result)
  }
  const hunkPatch = selected
    .filter((item): item is typeof item & { hunks: WorkspaceDiffHunk[] } => Boolean(item.hunks))
    .map((item) => workspaceUnifiedDiff(item.file, item.hunks))
    .join("")
  if (hunkPatch) {
    const args = ["apply", "--cached", "--recount", ...(action === "unstage" ? ["--reverse"] : []), "-"]
    const result = await runGit(binding.projectRoot, args, MAX_GIT_DIFF_BYTES, [0], hunkPatch)
    if (!result.ok) throw gitMutationError(action, result)
  }
  return {
    id: createID("changeop"),
    action,
    paths,
    revision,
    selections: selected.map((item) => item.selection.hunkIds
      ? { path: item.selection.path, hunkIds: [...item.selection.hunkIds] }
      : { path: item.selection.path }),
    createdAt: new Date().toISOString(),
  }
}

async function commitSessionChanges(
  binding: SessionWorkspaceBinding,
  revision: string,
  message: string,
): Promise<UiChangeOperation> {
  await currentSessionChangeDiff(binding, revision)
  const applyState = await readSessionWorkspaceApplyState(binding)
  const appliedPaths = new Set(activeSessionApplies(applyState.operations).flatMap((operation) => operation.paths))
  const git = await inspectGitWorkspace(binding.projectRoot)
  if (!git.available) {
    throw new PixiuError(git.message ?? "The project is not a Git worktree.", { code: "WORKSPACE_GIT_UNAVAILABLE" })
  }
  const paths = git.changedFiles
    .filter((file) => file.indexStatus !== " " && file.indexStatus !== "?")
    .map((file) => file.path)
  if (!paths.length) throw new PixiuError("There are no staged session changes to commit.", { code: "WORKSPACE_COMMIT_EMPTY" })
  const unrelated = paths.filter((path) => !appliedPaths.has(path))
  if (unrelated.length) {
    throw new PixiuError(`Refusing to include staged files outside this session: ${unrelated.join(", ")}`, {
      code: "WORKSPACE_COMMIT_SCOPE_CONFLICT",
    })
  }
  const committed = await runGit(binding.projectRoot, ["commit", "-m", message], MAX_GIT_DIFF_BYTES)
  if (!committed.ok) throw gitMutationError("commit", committed)
  const head = await runGit(binding.projectRoot, ["rev-parse", "HEAD"], 256)
  const commit = head.ok ? head.stdout.trim() : undefined
  return {
    id: createID("changeop"),
    action: "commit",
    paths,
    revision,
    createdAt: new Date().toISOString(),
    message,
    ...(commit ? { commit } : {}),
  }
}

async function currentSessionChangeDiff(binding: SessionWorkspaceBinding, revision: string) {
  const diff = await structuredWorkspaceDiff(binding.baselineRoot, binding.workRoot)
  if (diff.baseRevision !== binding.baseRevision) {
    throw new PixiuError("The session workspace baseline changed.", { code: "SESSION_WORKSPACE_BASELINE_CHANGED" })
  }
  if (diff.revision !== revision) {
    throw new PixiuError("The workspace changes changed since they were reviewed.", { code: "WORKSPACE_CHANGE_STALE" })
  }
  return diff
}

function selectedStageChanges(
  diff: StructuredWorkspaceDiff,
  selections: UiChangeSelection[],
) {
  const changedByPath = new Map(diff.files.map((file) => [file.path, file]))
  const selected = selections.map((selection) => {
    const file = changedByPath.get(selection.path)
    if (!file) {
      throw new PixiuError(`Unknown workspace change: ${selection.path}`, { code: "WORKSPACE_CHANGE_NOT_FOUND" })
    }
    if (!selection.hunkIds) return { file, selection }
    if (!selection.hunkIds.length || new Set(selection.hunkIds).size !== selection.hunkIds.length) {
      throw new PixiuError("Selected workspace hunks must be unique.", { code: "WORKSPACE_CHANGE_SELECTION_INVALID" })
    }
    if (file.hunksUnavailableReason || !file.hunks.length) {
      throw new PixiuError(`Line hunks are unavailable for ${selection.path}.`, { code: "WORKSPACE_HUNKS_UNAVAILABLE" })
    }
    const byId = new Map(file.hunks.map((hunk) => [hunk.id, hunk]))
    const hunks = selection.hunkIds.map((id) => {
      const hunk = byId.get(id)
      if (!hunk) throw new PixiuError(`Unknown workspace hunk for ${selection.path}.`, { code: "WORKSPACE_HUNK_NOT_FOUND" })
      return hunk
    })
    return { file, selection, hunks }
  })
  if (new Set(selected.map((item) => item.selection.path)).size !== selected.length) {
    throw new PixiuError("A workspace path was selected more than once.", { code: "WORKSPACE_CHANGE_REQUEST_INVALID" })
  }
  return selected.sort((left, right) => left.selection.path.localeCompare(right.selection.path))
}

async function unstageGitPaths(root: string, paths: string[]) {
  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"], 256)
  return head.ok
    ? await runGit(root, ["reset", "--quiet", "HEAD", "--", ...paths], MAX_GIT_STATUS_BYTES)
    : await runGit(root, ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths], MAX_GIT_STATUS_BYTES)
}

function gitMutationError(action: string, result: GitCommandResult) {
  const detail = redactSecrets(result.stderr.trim() || result.stdout.trim())
  return new PixiuError(`Git ${action} failed${detail ? `: ${detail}` : "."}`, {
    code: "WORKSPACE_GIT_COMMAND_FAILED",
  })
}

async function inspectGitWorkspace(root: string): Promise<UiWorkspaceGitSummary> {
  const repository = await runGit(root, ["rev-parse", "--is-inside-work-tree"], 256)
  if (!repository.ok || repository.stdout.trim() !== "true") {
    return repository.unavailable
      ? gitUnavailable("git_unavailable", "Git is not installed or cannot be started.")
      : gitUnavailable("not_repository", "This project is not inside a Git worktree.")
  }

  const status = await runGit(
    root,
    ["-c", "status.relativePaths=true", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", "--", "."],
    MAX_GIT_STATUS_BYTES,
  )
  if (!status.ok) return gitUnavailable("command_failed", "Git status could not be read.")

  const symbolicBranch = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 512)
  const detachedHead = symbolicBranch.ok ? undefined : await runGit(root, ["rev-parse", "--short", "HEAD"], 512)
  const branch = symbolicBranch.ok && symbolicBranch.stdout.trim()
    ? symbolicBranch.stdout.trim()
    : detachedHead?.ok && detachedHead.stdout.trim()
      ? `HEAD@${detachedHead.stdout.trim()}`
      : undefined
  return {
    available: true,
    changedFiles: parseGitStatus(status.stdout),
    ...(branch ? { branch } : {}),
    ...(status.truncated ? { truncated: true, message: "Git status was truncated." } : {}),
  }
}

function gitUnavailable(reason: NonNullable<UiWorkspaceGitSummary["reason"]>, message: string): UiWorkspaceGitSummary {
  return { available: false, changedFiles: [], reason, message }
}

function parseGitStatus(output: string): UiWorkspaceChangedFile[] {
  const records = output.split("\0")
  const changed: UiWorkspaceChangedFile[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const indexStatus = record[0] ?? " "
    const workingTreeStatus = record[1] ?? " "
    const path = safeGitPath(record.slice(3))
    const hasPreviousPath = indexStatus === "R" || indexStatus === "C" || workingTreeStatus === "R" || workingTreeStatus === "C"
    const originalPath = hasPreviousPath ? safeGitPath(records[++index] ?? "") : undefined
    if (hasPreviousPath && !originalPath) continue
    if (!path) continue
    changed.push({
      path,
      status: workspaceChangeStatus(indexStatus, workingTreeStatus),
      indexStatus,
      workingTreeStatus,
      ...(originalPath ? { originalPath } : {}),
    })
  }
  return changed.sort((left, right) => left.path.localeCompare(right.path))
}

function safeGitPath(path: string) {
  const value = path.startsWith("./") ? path.slice(2) : path
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) return undefined
  return value
}

function workspaceChangeStatus(indexStatus: string, workingTreeStatus: string): UiWorkspaceChangeStatus {
  const pair = `${indexStatus}${workingTreeStatus}`
  if (pair === "??") return "untracked"
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(pair)) return "conflicted"
  if (indexStatus === "R" || workingTreeStatus === "R") return "renamed"
  if (indexStatus === "C" || workingTreeStatus === "C") return "copied"
  if (indexStatus === "A" || workingTreeStatus === "A") return "added"
  if (indexStatus === "D" || workingTreeStatus === "D") return "deleted"
  if (indexStatus === "T" || workingTreeStatus === "T") return "type-changed"
  return "modified"
}

async function workspaceFileDiff(rootPath: string, path: string): Promise<UiWorkspaceDiff> {
  const target = await resolveWorkspaceTarget(rootPath, path, { allowMissing: true })
  try {
    const info = await stat(target.absolutePath)
    if (info.isDirectory()) throw new PixiuError("Only files can be diffed.", { code: "WORKSPACE_PATH_NOT_FILE" })
  } catch (error: any) {
    if (error instanceof PixiuError) throw error
    if (error?.code !== "ENOENT") throw error
  }

  const git = await inspectGitWorkspace(resolve(rootPath))
  if (!git.available) {
    return {
      path: target.relativePath,
      available: false,
      content: "",
      truncated: false,
      ...(git.reason ? { reason: git.reason } : {}),
      ...(git.message ? { message: git.message } : {}),
    }
  }
  const changed = git.changedFiles.find((file) => file.path === target.relativePath)
  if (!changed) {
    return {
      path: target.relativePath,
      available: false,
      content: "",
      truncated: false,
      reason: "unchanged",
      message: "This file has no Git changes.",
      ...(git.branch ? { branch: git.branch } : {}),
    }
  }

  const result = changed.status === "untracked"
    ? await runGit(
        rootPath,
        ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", target.relativePath],
        MAX_GIT_DIFF_BYTES,
        [0, 1],
      )
    : await gitDiffFromHead(rootPath, target.relativePath)
  if (!result.ok) {
    return {
      path: target.relativePath,
      available: false,
      content: "",
      truncated: result.truncated,
      status: changed.status,
      reason: result.unavailable ? "git_unavailable" : "command_failed",
      message: "Git diff could not be read for this file.",
      ...(git.branch ? { branch: git.branch } : {}),
    }
  }
  return {
    path: target.relativePath,
    available: Boolean(result.stdout),
    content: result.stdout,
    truncated: result.truncated,
    status: changed.status,
    ...(git.branch ? { branch: git.branch } : {}),
    ...(!result.stdout ? { reason: "unchanged" as const, message: "Git reported no textual diff for this file." } : {}),
  }
}

async function gitDiffFromHead(root: string, path: string): Promise<GitCommandResult> {
  const fromHead = await runGit(
    root,
    ["diff", "--no-ext-diff", "--no-color", "--relative", "HEAD", "--", path],
    MAX_GIT_DIFF_BYTES,
  )
  if (fromHead.ok) return fromHead

  const [staged, workingTree] = await Promise.all([
    runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-color", "--relative", "--", path], MAX_GIT_DIFF_BYTES),
    runGit(root, ["diff", "--no-ext-diff", "--no-color", "--relative", "--", path], MAX_GIT_DIFF_BYTES),
  ])
  if (!staged.ok || !workingTree.ok) return fromHead
  return {
    ok: true,
    exitCode: 0,
    stdout: [staged.stdout, workingTree.stdout].filter(Boolean).join("\n"),
    stderr: "",
    truncated: staged.truncated || workingTree.truncated,
    unavailable: false,
  }
}

type GitCommandResult = {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
  unavailable: boolean
}

async function runGit(
  root: string,
  args: string[],
  maxBytes: number,
  acceptedExitCodes: number[] = [0],
  input?: string,
): Promise<GitCommandResult> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn({
      cmd: ["git", "--no-optional-locks", "--literal-pathspecs", ...args],
      cwd: root,
      env: gitCommandEnvironment(),
      stdin: input === undefined ? "ignore" : Buffer.from(input, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    return { ok: false, exitCode: -1, stdout: "", stderr: "", truncated: false, unavailable: true }
  }
  const timeout = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readLimitedOutput(child.stdout as ReadableStream<Uint8Array>, maxBytes),
      readLimitedOutput(child.stderr as ReadableStream<Uint8Array>, 32 * 1024),
      child.exited,
    ])
    return {
      ok: acceptedExitCodes.includes(exitCode),
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      unavailable: false,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function gitCommandEnvironment() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key]
  }
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  }
}

async function readLimitedOutput(stream: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let storedBytes = 0
  let truncated = false
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    const remaining = Math.max(0, maxBytes - storedBytes)
    if (remaining > 0) {
      const stored = chunk.value.subarray(0, remaining)
      text += decoder.decode(stored, { stream: true })
      storedBytes += stored.byteLength
    }
    if (chunk.value.byteLength > remaining) truncated = true
  }
  text += decoder.decode()
  return { text, truncated }
}

async function uploadSessionFiles(session: SessionRecord, request: Request) {
  const form = await request.formData()
  const uploads: UiFileSummary[] = []
  await mkdir(session.cwd, { recursive: true })
  const uploadRoot = await resolveWorkspaceTarget(session.cwd, "uploads", { allowMissing: true })
  await mkdir(uploadRoot.absolutePath, { recursive: true })
  await resolveWorkspaceTarget(session.cwd, "uploads")
  let nextUploadBytes = await sessionUploadBytes(session.cwd)
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
    const target = await resolveWorkspaceTarget(session.cwd, join("uploads", safeName), { allowMissing: true })
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
  const target = await resolveWorkspaceTarget(session.cwd, path)
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
      "WORKSPACE_FILE_NOT_FOUND",
      "WORKSPACE_PATH_NOT_FILE",
      "WORKSPACE_ROOT_UNAVAILABLE",
      "UPLOAD_TOO_LARGE",
      "PROVIDER_API_KEY_MISSING",
      "PROJECT_ROOT_INVALID",
      "FS_PATH_INVALID",
      "WORKSPACE_CHANGE_REQUEST_INVALID",
      "WORKSPACE_CHANGE_SELECTION_INVALID",
      "WORKSPACE_CHANGE_PATH_RESERVED",
      "WORKSPACE_CHANGE_NOT_FOUND",
      "WORKSPACE_HUNK_NOT_FOUND",
      "WORKSPACE_HUNKS_UNAVAILABLE",
      "WORKSPACE_COMMIT_MESSAGE_INVALID",
      "WORKSPACE_VALIDATION_KEY_INVALID",
      "WORKSPACE_VALIDATION_KIND_INVALID",
      "WORKSPACE_VALIDATION_COMMAND_INVALID",
      "WORKSPACE_VALIDATION_PRESET_OVERRIDE",
      "WORKSPACE_VALIDATION_PRESET_UNAVAILABLE",
      "WORKSPACE_VALIDATION_CONFIRMATION_REQUIRED",
    ].includes(error.code)
  ) {
    return 400
  }
  if (
    error instanceof PixiuError &&
    [
      "SESSION_RUN_ACTIVE",
      "WORKSPACE_CHANGE_STALE",
      "WORKSPACE_CHANGE_CONFLICT",
      "WORKSPACE_CHANGE_ALREADY_APPLIED",
      "WORKSPACE_CHANGE_NOT_APPLIED",
      "WORKSPACE_CHANGE_NOT_STAGED",
      "WORKSPACE_UNDO_EMPTY",
      "WORKSPACE_COMMIT_EMPTY",
      "WORKSPACE_COMMIT_SCOPE_CONFLICT",
      "SESSION_WORKSPACE_UNAVAILABLE",
    ].includes(error.code)
  ) {
    return 409
  }
  if (error instanceof PixiuError && ["TURN_NOT_FOUND", "SESSION_NOT_FOUND"].includes(error.code)) return 404
  return 500
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function uiSessionsRoot(cwd: string) {
  return join(cwd, ".pixiu/state/sessions")
}

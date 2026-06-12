import type { PixiuConfig } from "../../config/defaults"
import type { JsonValue } from "../../shared/json"
import type { SessionEvidence } from "../../session/evidence"
import type { SessionMessage } from "../../session/types"
import type { AgentEvent } from "../../agent/events"

export type ApiSuccess<T> = {
  ok: true
  data: T
}

export type ApiFailure = {
  ok: false
  code: string
  message: string
  details?: JsonValue
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

export type UiProviderSummary = {
  baseURL?: string
  model: string
  credential: "apiKey" | "apiKeyEnv" | "none"
  apiKeyEnv?: string
  keyPresent: boolean
}

export type UiWorkspaceSummary = {
  mode: PixiuConfig["sandbox"]["mode"]
  workspaceDir: string
  workspaceOnly: boolean
  shellTimeoutMs: number
  outputMaxBytes: number
}

export type UiStatus = {
  version: string
  cwd: string
  provider: UiProviderSummary
  workspace: UiWorkspaceSummary
  sessionsPath: string
  skills: {
    paths: string[]
    diagnostics: number
  }
  mcp: {
    configured: number
    connected?: number
    failed?: number
    disabled?: number
  }
}

export type UiConfigResponse = {
  config: JsonValue
  provider: UiProviderSummary
}

export type UiSessionSummary = {
  id: string
  cwd: string
  createdAt: string
  updatedAt: string
  title?: string
  model?: string
  finishStatus?: string
  workspaceDir?: string
  summaryApproxTokens: number
}

export type UiFileSummary = {
  path: string
  size: number
  updatedAt: string
  kind: "text" | "binary"
}

export type UiSessionDetail = {
  session: UiSessionSummary
  messages: SessionMessage[]
  evidence: SessionEvidence
  files: UiFileSummary[]
}

export type UiRunStatus = "queued" | "running" | "waiting_permission" | "done" | "error" | "cancelled"

export type UiRunEvent =
  | { event: "run"; data: { runId: string; status: UiRunStatus } }
  | { event: "agent_event"; data: AgentEvent }
  | { event: "permission_request"; data: unknown }
  | { event: "permission_result"; data: unknown }
  | { event: "result"; data: UiRunResult }
  | { event: "error"; data: { message: string } }

export type UiRunResult = {
  runId: string
  status: UiRunStatus
  sessionId?: string
  answer: string
  finishReason: string
  events: AgentEvent[]
  error?: string
}

export function apiSuccess<T>(data: T): ApiSuccess<T> {
  return { ok: true, data }
}

export function apiFailure(code: string, message: string, details?: JsonValue): ApiFailure {
  return details === undefined ? { ok: false, code, message } : { ok: false, code, message, details }
}

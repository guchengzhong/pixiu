import type { PixiuConfig } from "../../config/defaults"
import type { JsonValue } from "../../shared/json"
import type { SessionEvidence } from "../../session/evidence"
import type { SessionMessage, SessionTurn } from "../../session/types"
import type { AgentEvent } from "../../agent/events"
import type { ActivityItem, ActivityUpdatedEvent } from "../../activity/types"
import type { TodoItem } from "../../todo/types"
import type { RunStatus, RunStatusEvent, TerminalRunStatus } from "../../run/status"
import type { SkillSummary } from "../../skills/types"
import type { MCPServerStatus } from "../../mcp/types"

export type { RunStatus, RunStatusEvent, TerminalRunStatus } from "../../run/status"
export type { ActivityItem, ActivityKind, ActivityMetadata, ActivitySource, ActivityStatus, ActivityUpdatedEvent } from "../../activity/types"

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

export type UiFsEntry = {
  name: string
  path: string
}

export type UiFsListing = {
  path: string
  parent?: string
  entries: UiFsEntry[]
  drives: string[]
  home: string
}

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

export type UiProjectSummary = {
  id: string
  name: string
  rootPath: string
  createdAt: string
  updatedAt: string
  sessionCount: number
  lastSessionId?: string
}

export type UiSessionSummary = {
  id: string
  projectId?: string
  cwd: string
  createdAt: string
  updatedAt: string
  title?: string
  titleSource?: "auto" | "user"
  model?: string
  finishStatus?: TerminalRunStatus
  workspaceDir?: string
  preview?: string
  artifactCount?: number
  activityCount?: number
  summaryApproxTokens: number
}

export type UiFileSummary = {
  path: string
  size: number
  updatedAt: string
  kind: "text" | "binary"
}

export type UiPromptFileReference = {
  path: string
  source: "uploaded" | "workspace" | "generated" | "evidence"
  startLine?: number
  endLine?: number
}

export type UiWorkspaceChangeStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type-changed"
  | "untracked"
  | "conflicted"

export type UiWorkspaceChangedFile = {
  path: string
  status: UiWorkspaceChangeStatus
  indexStatus: string
  workingTreeStatus: string
  originalPath?: string
}

export type UiWorkspaceEntry = {
  path: string
  name: string
  parentPath: string
  type: "directory" | "file" | "symlink"
  size?: number
  updatedAt?: string
  kind?: "text" | "binary"
  gitStatus?: UiWorkspaceChangeStatus
}

export type UiWorkspaceGitSummary = {
  available: boolean
  changedFiles: UiWorkspaceChangedFile[]
  branch?: string
  reason?: "not_repository" | "git_unavailable" | "command_failed"
  message?: string
  truncated?: boolean
}

export type UiWorkspaceSnapshot = {
  available: boolean
  projectId: string
  projectName: string
  rootPath: string
  entries: UiWorkspaceEntry[]
  truncated: boolean
  git: UiWorkspaceGitSummary
  message?: string
}

export type UiWorkspaceFileContent = {
  path: string
  size: number
  updatedAt: string
  content: string
}

export type UiWorkspaceDiff = {
  path: string
  available: boolean
  content: string
  truncated: boolean
  status?: UiWorkspaceChangeStatus
  branch?: string
  reason?: "not_repository" | "git_unavailable" | "command_failed" | "unchanged"
  message?: string
}

export type UiChangeSetStatus = "added" | "deleted" | "modified" | "type-changed"

export type UiChangeSetHunk = {
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string
}

export type UiChangeSetFile = {
  path: string
  status: UiChangeSetStatus
  binary: boolean
  size: number
  hunkCount: number
  additions: number
  deletions: number
  appliedHunkIds: string[]
  applied: boolean
  staged: boolean
  committed: boolean
}

export type UiChangeSetSnapshot = {
  available: boolean
  sessionId: string
  projectId?: string
  projectRoot?: string
  createdAt?: string
  baseRevision?: string
  workRevision?: string
  revision?: string
  changes: UiChangeSetFile[]
  canUndo: boolean
  message?: string
}

export type UiChangeSetDiff = {
  path: string
  available: boolean
  status?: UiChangeSetStatus
  revision?: string
  binary: boolean
  content: string
  hunks: UiChangeSetHunk[]
  truncated: boolean
  message?: string
}

export type UiChangeSelection = {
  path: string
  hunkIds?: string[]
}

export type UiChangeOperation = {
  id: string
  action: "apply" | "discard" | "undo" | "stage" | "unstage" | "commit"
  paths: string[]
  createdAt: string
  revision?: string
  selections?: UiChangeSelection[]
  commit?: string
  message?: string
}

export type UiChangeMutationResult = {
  operation: UiChangeOperation
  changes: UiChangeSetSnapshot
}

export type UiValidationKind = "test" | "typecheck" | "build" | "custom"

export type UiValidationRecord = {
  id: string
  sessionId: string
  turnId: string
  revision: string
  kind: UiValidationKind
  command: string
  status: "passed" | "failed" | "cancelled"
  startedAt: string
  completedAt: string
  durationMs: number
  exitCode: number
  output: string
  truncated: boolean
  timedOut: boolean
}

export type UiSessionDetail = {
  session: UiSessionSummary
  messages: SessionMessage[]
  evidence: SessionEvidence
  files: UiFileSummary[]
  todos: TodoItem[]
  activity: ActivityItem[]
  turns: SessionTurn[]
  validations: UiValidationRecord[]
}

export type UiSkillSummary = SkillSummary & {
  referenceCount: number
}

export type UiMcpServerSummary = MCPServerStatus & {
  command?: string
  url?: string
  enabled: boolean
}

export type UiRunStatus = RunStatus

export type UiRunEvent =
  | { event: "run_status"; data: RunStatusEvent }
  | { event: "run"; data: { runId: string; status: string; runStatus: UiRunStatus } }
  | { event: "activity_updated"; data: ActivityUpdatedEvent }
  | { event: "agent_event"; data: AgentEvent }
  | { event: "permission_request"; data: unknown }
  | { event: "permission_result"; data: unknown }
  | { event: "result"; data: UiRunResult }
  | { event: "error"; data: { message: string } }

export type UiRunResult = {
  runId: string
  turnId: string
  status: TerminalRunStatus
  sessionId?: string
  model?: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  retryCount: number
  retryOf?: string
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

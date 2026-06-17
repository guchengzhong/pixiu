export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_permission"
  | "idle"
  | "error"
  | "cancelled"

export type RunStatusPhase = "starting" | "llm" | "tool" | "permission" | "finalizing"

export type RunStatusEvent = {
  type: "run_status"
  runId: string
  sessionId?: string
  status: RunStatus
  phase?: RunStatusPhase
  message?: string
  toolCallId?: string
  toolName?: string
  permissionId?: string
  updatedAt: string
}

export type TerminalRunStatus = Extract<RunStatus, "idle" | "error" | "cancelled">

const RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "waiting_for_permission",
  "idle",
  "error",
  "cancelled",
])

export function normalizeRunStatus(value: unknown): RunStatus | undefined {
  if (value === "waiting_permission") return "waiting_for_permission"
  if (value === "done") return "idle"
  return typeof value === "string" && RUN_STATUSES.has(value as RunStatus) ? (value as RunStatus) : undefined
}

export function normalizePersistedRunStatus(value: unknown): TerminalRunStatus {
  const status = normalizeRunStatus(value)
  if (status === "error" || status === "cancelled") return status
  return "idle"
}

export function isActiveRunStatus(status: RunStatus) {
  return status === "queued" || status === "running" || status === "waiting_for_permission"
}

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return status === "idle" || status === "error" || status === "cancelled"
}

export function runStatusLabel(status: RunStatus) {
  if (status === "queued") return "Starting"
  if (status === "running") return "Working"
  if (status === "waiting_for_permission") return "Waiting for permission"
  if (status === "error") return "Error"
  if (status === "cancelled") return "Cancelled"
  return "Ready"
}

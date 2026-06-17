import type { JsonObject } from "../shared/json"

export type ActivitySource =
  | "llm_intent"
  | "tool_metadata"
  | "fallback"
  | "system"

export type ActivityStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "skipped"
  | "cancelled"

export type ActivityKind =
  | "tool"
  | "file"
  | "shell"
  | "search"
  | "skill"
  | "permission"
  | "artifact"
  | "system"
  | "other"

export type ActivityItem = {
  id: string
  runId?: string
  sessionId?: string
  kind: ActivityKind
  status: ActivityStatus
  title: string
  summary?: string
  toolCallId?: string
  toolName?: string
  target?: string
  command?: string
  startedAt?: string
  endedAt?: string
  rawEventIds?: string[]
  details?: JsonObject
  source?: ActivitySource
}

export type ActivityMetadata = {
  kind?: ActivityKind
  title?: string
  summary?: string
  target?: string
  command?: string
  status?: ActivityStatus
  details?: JsonObject
}

export type ActivityUpdatedEvent = {
  type: "activity_updated"
  runId?: string
  sessionId?: string
  activity: ActivityItem[]
  item?: ActivityItem
}

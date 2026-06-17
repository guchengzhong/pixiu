import type { ActivityItem, ActivityKind, ActivityMetadata, ActivityStatus } from "./types"
import type { JsonObject, JsonValue } from "../shared/json"

export const MAX_ACTIVITY_ITEMS = 100

const ACTIVITY_STATUSES = new Set<ActivityStatus>(["pending", "running", "success", "error", "skipped", "cancelled"])
const ACTIVITY_KINDS = new Set<ActivityKind>(["tool", "file", "shell", "search", "skill", "permission", "artifact", "system", "other"])

export type ToolActivityInput = {
  runId?: string
  sessionId?: string
  toolCallId: string
  toolName: string
  input?: unknown
  ok: boolean
  content?: string
  metadata?: unknown
  startedAt?: string
  endedAt?: string
}

export type ToolIntentActivityInput = {
  runId?: string
  sessionId?: string
  toolCallId: string
  toolName: string
  input?: unknown
  startedAt?: string
}

export function activityFromToolIntent(input: ToolIntentActivityInput): ActivityItem | undefined {
  const activityMetadata = toolCallActivityMetadata(input.input)
  if (!activityMetadata) return undefined
  return {
    id: stableActivityId("act", input.runId, input.toolCallId, input.toolName),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    kind: activityMetadata.kind ?? "tool",
    status: "running",
    title: activityMetadata.title ?? `Using ${input.toolName}`,
    ...(activityMetadata.summary ? { summary: activityMetadata.summary } : {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(activityMetadata.target ? { target: activityMetadata.target } : {}),
    ...(activityMetadata.command ? { command: activityMetadata.command } : {}),
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    rawEventIds: [`tool_call:${input.toolCallId}`],
    ...(activityMetadata.details ? { details: activityMetadata.details } : {}),
    source: "llm_intent",
  }
}

export function activityFromToolResult(input: ToolActivityInput): ActivityItem {
  const metadata = objectValue(input.metadata)
  const activityMetadata = normalizeActivityMetadata(metadata.activity)
  const fallback = fallbackToolActivity(input.toolName, input.input, input.metadata, input.ok)
  const effectiveMetadata = preferFallbackOverGenericActivity(activityMetadata, fallback)
  const source = Object.keys(effectiveMetadata).length ? "tool_metadata" : "fallback"
  const status = activityMetadata.status ?? toolResultStatus(input.ok, metadata) ?? fallback.status ?? (input.ok ? "success" : "error")
  const item: ActivityItem = {
    id: stableActivityId("act", input.runId, input.toolCallId, input.toolName),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    kind: effectiveMetadata.kind ?? fallback.kind,
    status,
    title: effectiveMetadata.title ?? fallback.title,
    ...(effectiveMetadata.summary ?? fallback.summary ? { summary: effectiveMetadata.summary ?? fallback.summary } : {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(effectiveMetadata.target ?? fallback.target ? { target: effectiveMetadata.target ?? fallback.target } : {}),
    ...(effectiveMetadata.command ?? fallback.command ? { command: effectiveMetadata.command ?? fallback.command } : {}),
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    rawEventIds: [`tool_call:${input.toolCallId}`, `tool_result:${input.toolCallId}`],
    ...(effectiveMetadata.details ?? fallback.details ? { details: effectiveMetadata.details ?? fallback.details } : {}),
    source,
  }
  return item
}

export function updateActivityWithToolResult(existing: ActivityItem, result: ActivityItem, ok: boolean): ActivityItem {
  const status = result.status ?? (ok ? "success" : "error")
  const summary = shouldKeepIntentSummary(existing, result)
    ? existing.summary ?? result.summary
    : result.summary ?? existing.summary
  return {
    ...existing,
    status,
    title: finalIntentTitle(existing.title, status),
    ...(summary ? { summary } : {}),
    ...(result.target ? { target: result.target } : existing.target ? { target: existing.target } : {}),
    ...(result.command ? { command: result.command } : existing.command ? { command: existing.command } : {}),
    ...(result.endedAt ? { endedAt: result.endedAt } : {}),
    rawEventIds: uniqueStrings([...(existing.rawEventIds ?? []), ...(result.rawEventIds ?? [])]),
    ...(existing.details || result.details ? { details: { ...(existing.details ?? {}), ...(result.details ?? {}) } } : {}),
    ...(existing.source ?? result.source ? { source: existing.source ?? result.source } : {}),
  }
}

export function stripToolActivityInput<T extends JsonObject>(input: T): T {
  if (!("_activity" in input)) return input
  const { _activity, ...rest } = input
  void _activity
  return rest as T
}

export function toolCallActivityMetadata(input: unknown): ActivityMetadata | undefined {
  const raw = objectValue(input)
  if (!("_activity" in raw)) return undefined
  const metadata = normalizeActivityMetadata(raw._activity)
  return Object.keys(metadata).length ? metadata : undefined
}

export function normalizeActivityMetadata(value: unknown): ActivityMetadata {
  const raw = objectValue(value)
  const kind = normalizeActivityKind(raw.kind)
  const status = normalizeActivityStatus(raw.status)
  const title = stringValue(raw.title)
  const summary = stringValue(raw.summary)
  const target = stringValue(raw.target)
  const command = stringValue(raw.command)
  const details = jsonObjectValue(raw.details)
  return {
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(target ? { target } : {}),
    ...(command ? { command } : {}),
    ...(status ? { status } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  }
}

export function normalizeActivityItems(value: unknown): ActivityItem[] {
  if (!Array.isArray(value)) return []
  const items = value
    .map(normalizeActivityItem)
    .filter((item): item is ActivityItem => Boolean(item))
  return limitActivityItems(items)
}

export function normalizePersistedActivityItems(value: unknown): ActivityItem[] {
  return normalizeActivityItems(value).map((item) => (
    item.status === "running" || item.status === "pending"
      ? { ...item, status: "cancelled" as const, ...(item.endedAt ?? item.startedAt ? { endedAt: item.endedAt ?? item.startedAt } : {}) }
      : item
  ))
}

export function limitActivityItems(items: ActivityItem[], limit = MAX_ACTIVITY_ITEMS) {
  return items.slice(Math.max(0, items.length - limit))
}

export function stableActivityId(prefix: string, ...parts: Array<string | undefined>) {
  const suffix = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean)
    .join("_")
    .slice(0, 140)
  return suffix ? `${prefix}_${suffix}` : prefix
}

export function activityStatusMarker(status: ActivityStatus) {
  if (status === "success") return "✓"
  if (status === "error") return "✕"
  if (status === "running") return "●"
  if (status === "skipped") return "-"
  if (status === "cancelled") return "×"
  return "○"
}

function fallbackToolActivity(toolName: string, input: unknown, metadata: unknown, ok: boolean): Omit<ActivityItem, "id"> {
  const lower = toolName.toLowerCase()
  const inputObject = objectValue(input)
  const metadataObject = objectValue(metadata)
  const target = stringValue(metadataObject.path) ?? stringValue(inputObject.path) ?? stringValue(metadataObject.url) ?? stringValue(inputObject.url)
  const command = stringValue(metadataObject.command) ?? stringValue(inputObject.command)
  const query = stringValue(metadataObject.query) ?? stringValue(inputObject.query)
  const status: ActivityStatus = toolResultStatus(ok, metadataObject) ?? (ok ? "success" : "error")

  if (lower === "read" || lower.includes("read")) {
    return fileActivity(status, ok ? "Read file" : "Read file failed", target)
  }
  if (lower === "write" || lower.includes("write")) {
    return fileActivity(status, ok ? "Updated file" : "File update failed", target)
  }
  if (lower === "edit" || lower.includes("edit") || lower === "patch" || lower.includes("patch")) {
    return fileActivity(status, ok ? "Edited file" : "File edit failed", target)
  }
  if (lower === "shell" || lower.includes("shell") || lower.includes("bash")) {
    const weather = command ? weatherActivityFromCommand(command, status) : undefined
    if (weather) {
      const shell = shellDetails(metadataObject)
      return {
        ...weather,
        ...(shell.details ? { details: { ...(weather.details ?? {}), ...shell.details } } : {}),
      }
    }
    return {
      kind: "shell",
      status,
      title: ok ? "Ran command" : "Command failed",
      ...(command ? { summary: ok ? `Ran ${command}` : `Failed ${command}`, command } : {}),
      ...shellDetails(metadataObject),
    }
  }
  if (lower.includes("skill")) {
    const skill = stringValue(metadataObject.name) ?? stringValue(inputObject.name) ?? target
    return {
      kind: "skill",
      status,
      title: ok ? "Used skill" : "Skill failed",
      ...(skill ? { summary: `Used ${skill}`, target: skill } : {}),
    }
  }
  if (lower.includes("grep") || lower.includes("glob") || lower.includes("search")) {
    const summaryTarget = query ?? target
    return {
      kind: "search",
      status,
      title: ok ? "Searched" : "Search failed",
      ...(summaryTarget ? { summary: `Searched ${summaryTarget}`, target: summaryTarget } : {}),
    }
  }
  if (lower.includes("fetch")) {
    return {
      kind: "search",
      status,
      title: ok ? "Fetched resource" : "Fetch failed",
      ...(target ? { summary: `Fetched ${target}`, target } : {}),
    }
  }
  return {
    kind: "tool",
    status,
    title: `Used tool: ${toolName}`,
  }
}

function fileActivity(status: ActivityStatus, title: string, target: string | undefined) {
  return {
    kind: "file" as const,
    status,
    title,
    ...(target ? { summary: `${title} ${target}`, target } : {}),
  }
}

function weatherActivityFromCommand(command: string, status: ActivityStatus): Omit<ActivityItem, "id"> | undefined {
  const parsed = wttrUrlFromCommand(command)
  if (!parsed) return undefined
  const city = decodeURIComponent(parsed.pathname.replace(/^\/+/, "") || parsed.searchParams.get("m") || "weather").trim()
  const label = city || "weather"
  const verb = status === "error" ? "Failed to check" : status === "skipped" ? "Skipped checking" : "Checked"
  return {
    kind: "search",
    status,
    title: `${verb} ${label} weather`,
    summary: `${status === "error" ? "Failed to fetch" : status === "skipped" ? "Skipped fetching" : "Fetched"} current weather data from wttr.in`,
    target: label,
    command,
    details: { provider: "wttr.in" },
  }
}

function wttrUrlFromCommand(command: string) {
  const match = command.match(/(?:https?:\/\/)?(?:[^/\s'"]+\.)?wttr\.in\/[^\s'"]+/i)
  const raw = match?.[0]?.trim()
  if (!raw) return undefined
  const value = raw.startsWith("http") ? raw : `https://${raw}`
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function preferFallbackOverGenericActivity(metadata: ActivityMetadata, fallback: Omit<ActivityItem, "id">) {
  if (metadata.title && isGenericCommandTitle(metadata.title) && fallback.title !== metadata.title) {
    return {}
  }
  return metadata
}

function isGenericCommandTitle(title: string) {
  return title === "Ran command" || title === "Command failed"
}

function shouldKeepIntentSummary(existing: ActivityItem, result: ActivityItem) {
  if (existing.source !== "llm_intent") return false
  if (result.toolName !== "shell" || !result.command || !result.summary) return false
  if (!isGenericCommandTitle(result.title)) return false
  return result.summary === `Ran ${result.command}` || result.summary === `Failed ${result.command}`
}

function shellDetails(metadata: Record<string, unknown>) {
  const details: JsonObject = {}
  for (const key of ["exitCode", "timedOut", "durationMs"]) {
    const value = metadata[key]
    if (typeof value === "number" || typeof value === "boolean") details[key] = value
  }
  return Object.keys(details).length ? { details } : {}
}

function toolResultStatus(ok: boolean, metadata: Record<string, unknown>): ActivityStatus | undefined {
  if (metadata.permissionAction === "deny") return "skipped"
  return ok ? "success" : "error"
}

function normalizeActivityItem(value: unknown): ActivityItem | undefined {
  const raw = objectValue(value)
  const id = stringValue(raw.id)
  const kind = normalizeActivityKind(raw.kind)
  const status = normalizeActivityStatus(raw.status)
  const title = stringValue(raw.title)
  if (!id || !kind || !status || !title) return undefined
  const rawEventIds = Array.isArray(raw.rawEventIds) ? raw.rawEventIds.filter((item): item is string => typeof item === "string") : undefined
  const details = jsonObjectValue(raw.details)
  const runId = stringValue(raw.runId)
  const sessionId = stringValue(raw.sessionId)
  const summary = stringValue(raw.summary)
  const toolCallId = stringValue(raw.toolCallId)
  const toolName = stringValue(raw.toolName)
  const target = stringValue(raw.target)
  const command = stringValue(raw.command)
  const startedAt = stringValue(raw.startedAt)
  const endedAt = stringValue(raw.endedAt)
  const source = normalizeActivitySource(raw.source)
  return {
    id,
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    kind,
    status,
    title,
    ...(summary ? { summary } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(target ? { target } : {}),
    ...(command ? { command } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(rawEventIds?.length ? { rawEventIds } : {}),
    ...(Object.keys(details).length ? { details } : {}),
    ...(source ? { source } : {}),
  }
}

function finalIntentTitle(title: string, status: ActivityStatus) {
  if (status === "success") {
    return title
      .replace(/^Checking\b/i, "Checked")
      .replace(/^Fetching\b/i, "Fetched")
      .replace(/^Reading\b/i, "Read")
      .replace(/^Running\b/i, "Ran")
      .replace(/^Updating\b/i, "Updated")
      .replace(/^Editing\b/i, "Edited")
  }
  if (status === "error" && !/^Failed\b/i.test(title)) {
    return title
      .replace(/^Checking\b/i, "Failed to check")
      .replace(/^Fetching\b/i, "Failed to fetch")
      .replace(/^Reading\b/i, "Failed to read")
      .replace(/^Running\b/i, "Failed to run")
      .replace(/^Updating\b/i, "Failed to update")
      .replace(/^Editing\b/i, "Failed to edit")
  }
  return title
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function normalizeActivitySource(value: unknown): ActivityItem["source"] | undefined {
  return value === "llm_intent" || value === "tool_metadata" || value === "fallback" || value === "system" ? value : undefined
}

function normalizeActivityKind(value: unknown): ActivityKind | undefined {
  return typeof value === "string" && ACTIVITY_KINDS.has(value as ActivityKind) ? (value as ActivityKind) : undefined
}

function normalizeActivityStatus(value: unknown): ActivityStatus | undefined {
  return typeof value === "string" && ACTIVITY_STATUSES.has(value as ActivityStatus) ? (value as ActivityStatus) : undefined
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function jsonObjectValue(value: unknown): JsonObject {
  const raw = objectValue(value)
  const next: JsonObject = {}
  for (const [key, item] of Object.entries(raw)) {
    const json = jsonValue(item)
    if (json !== undefined) next[key] = json
  }
  return next
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    const next = value.map(jsonValue).filter((item): item is JsonValue => item !== undefined)
    return next
  }
  if (value && typeof value === "object") return jsonObjectValue(value)
  return undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

import type { ActivityItem, RunStatus } from "../shared/api"
import type { UiMcpServerSummary, UiProjectSummary, UiSkillSummary } from "../shared/api"

export type TraceItem = {
  id: string
  title: string
  detail?: string
  kind?: string
  failed?: boolean
}

export type ChatMessage = {
  role: "user" | "assistant"
  text: string
  pending?: boolean
}

export type FileReferenceSource = "uploaded" | "workspace" | "generated" | "evidence"

export type FileReference = {
  path: string
  name: string
  source: FileReferenceSource
  status: "uploaded" | "ready" | "referenced"
  size?: number
  kind?: "text" | "binary"
}

export type FilePreview = {
  path: string
  content?: string
  message?: string
  status: "ready" | "unsupported" | "error"
}

export type PermissionView = {
  id: string
  request: {
    tool?: string
    input?: unknown
    risk?: string
    cwd?: string
  }
  decision: {
    reason?: string
  }
}

export type InspectorTab = "activity" | "files" | "evidence" | "status" | "api"

export type WorkbenchPanel = "chat" | "projects" | "skills" | "mcp" | "workspace" | "settings"

export type StatusSummary = {
  cwd?: string
  workspace?: string
  sessionsPath?: string
  skills?: number
  mcp?: {
    configured?: number
    connected?: number
    failed?: number
    disabled?: number
  }
  providerKeyPresent?: boolean
  runStatus?: RunStatus
  runStatusLabel?: string
}

export type ProjectListState = {
  projects: UiProjectSummary[]
  currentProjectId?: string
}

export type WorkbenchData = {
  projects: ProjectListState
  skills: UiSkillSummary[]
  mcpServers: UiMcpServerSummary[]
}

export type { RunStatus } from "../shared/api"
export type { ActivityItem } from "../shared/api"
export type { UiMcpServerSummary, UiProjectSummary, UiSkillSummary } from "../shared/api"

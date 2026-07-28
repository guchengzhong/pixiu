import type { ActivityItem, RunStatus } from "../shared/api"
import type { UiMcpServerSummary, UiProjectSummary, UiSkillSummary } from "../shared/api"
import type { MessagePart, SessionTurn } from "../../session/types"

export type TraceItem = {
  id: string
  title: string
  detail?: string
  kind?: string
  failed?: boolean
}

export type ChatMessage = {
  id: string
  turnId?: string
  role: "user" | "assistant"
  text: string
  pending?: boolean
  createdAt?: string
  parts?: MessagePart[]
  attachments?: FileReference[]
  tools?: TurnTool[]
  artifacts?: TurnArtifact[]
  turn?: SessionTurn
}

export type TurnTool = {
  id: string
  name: string
  status: "running" | "success" | "failed"
  detail?: string
}

export type TurnArtifact = {
  kind: "artifact" | "source"
  tool: string
  label: string
  path?: string
  url?: string
}

export type FileReferenceSource = "uploaded" | "workspace" | "generated" | "evidence"

export type FileReference = {
  path: string
  name: string
  source: FileReferenceSource
  status: "uploaded" | "ready" | "referenced"
  size?: number
  kind?: "text" | "binary"
  startLine?: number
  endLine?: number
}

export type FileReferenceRange = Pick<FileReference, "startLine" | "endLine">

export type FilePreview = {
  path: string
  content?: string
  message?: string
  status: "ready" | "unsupported" | "error"
}

export type PermissionView = {
  id: string
  sessionId?: string
  submitting?: boolean
  error?: string
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

export type InspectorTab = "activity" | "changes" | "files"

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

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

export type InspectorTab = "trace" | "files" | "evidence" | "status"

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
}

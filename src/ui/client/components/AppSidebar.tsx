import { useMemo, useState } from "react"

import type { UiSessionSummary } from "../../shared/api"
import type { StatusSummary } from "../types"
import { pathBasename, shortDate } from "../helpers"

function SidebarToggleIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <path d="M10 5v14" />
    </svg>
  )
}

function NewChatIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5H7a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-5" />
      <path d="M14 4h6v6" />
      <path d="M10 14 20 4" />
    </svg>
  )
}

function ApiIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v4" />
      <path d="M12 16v4" />
      <path d="M4 12h4" />
      <path d="M16 12h4" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  )
}

export function AppSidebar({
  sessions,
  sessionId,
  providerReady,
  workspace,
  status,
  sessionsLoading,
  sessionsError,
  collapsed,
  onToggleCollapsed,
  onNewChat,
  onConfigureApi,
  onLoadSession,
}: {
  sessions: UiSessionSummary[]
  sessionId: string | undefined
  providerReady: boolean
  workspace: string | undefined
  status: StatusSummary | undefined
  sessionsLoading: boolean
  sessionsError: string | undefined
  collapsed: boolean
  onToggleCollapsed(): void
  onNewChat(): void
  onConfigureApi(): void
  onLoadSession(sessionId: string): void
}) {
  const [query, setQuery] = useState("")
  const normalizedQuery = query.trim().toLowerCase()
  const filteredSessions = useMemo(() => {
    if (!normalizedQuery) return sessions
    return sessions.filter((session) =>
      [
        session.title ?? "Untitled chat",
        session.workspaceDir ?? "",
        session.cwd,
        session.model ?? "",
        session.finishStatus ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    )
  }, [normalizedQuery, sessions])
  const activeSession = sessions.find((session) => session.id === sessionId)
  const activeProjectPath = status?.cwd ?? activeSession?.cwd ?? workspace
  const activeProjectName = pathBasename(activeProjectPath) || "Project"
  const skillCount = status?.skills ?? 0
  const mcpConnected = status?.mcp?.connected ?? 0
  const mcpConfigured = status?.mcp?.configured ?? 0

  return (
    <aside className="sidebar workbench-sidebar">
      <div className="brand">
        <div className="brand-mark">P</div>
        <div className="brand-text">Pixiu</div>
        <button className="icon-button sidebar-toggle" type="button" title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapsed}>
          <SidebarToggleIcon />
        </button>
      </div>
      <div className="sidebar-actions">
        <button className="side-button" onClick={onNewChat} title="New chat">
          <span className="side-icon"><NewChatIcon /></span>
          <span className="label">New chat</span>
        </button>
        <button className="side-button" onClick={onConfigureApi} title="Configure API">
          <span className="side-icon"><ApiIcon /></span>
          <span className="label">Configure API</span>
        </button>
      </div>
      <div className="side-section">
        <div className="sidebar-search">
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search sessions" />
        </div>
        <div className="side-title">Workbench</div>
        <div className="nav-list">
          <button className="nav-item active" type="button" title={activeProjectPath ?? "Current project"}>
            <span className="nav-icon">P</span>
            <span className="nav-label">Projects</span>
            <span className="nav-meta">{activeProjectName}</span>
          </button>
          <button className="nav-item placeholder" type="button" title="Skills Center placeholder">
            <span className="nav-icon">S</span>
            <span className="nav-label">Skills</span>
            <span className="nav-count">{skillCount}</span>
          </button>
          <button className="nav-item placeholder" type="button" title="MCP status placeholder">
            <span className="nav-icon">M</span>
            <span className="nav-label">MCP</span>
            <span className="nav-count">{mcpConnected}/{mcpConfigured}</span>
          </button>
          <button className="nav-item placeholder" type="button" title={workspace ?? "Workspace"}>
            <span className="nav-icon">W</span>
            <span className="nav-label">Workspace</span>
          </button>
          <button className="nav-item" type="button" title="Settings / API" onClick={onConfigureApi}>
            <span className="nav-icon">A</span>
            <span className="nav-label">Settings / API</span>
            <span className={`nav-status ${providerReady ? "ok" : "warn"}`} />
          </button>
        </div>
        <div className="side-title">Current Project</div>
        <div className="project-card" title={activeProjectPath ?? "Project path unavailable"}>
          <div className="project-name">{activeProjectName}</div>
          <div className="project-path">{activeProjectPath ?? "loading"}</div>
        </div>
        <div className="side-title">Sessions</div>
        {sessionsLoading ? (
          <div className="sidebar-empty">
            <strong>Loading sessions</strong>
            <span>Restoring recent Pixiu workbench sessions.</span>
          </div>
        ) : sessionsError ? (
          <div className="sidebar-empty error">
            <strong>Session list failed</strong>
            <span>{sessionsError}</span>
          </div>
        ) : !sessions.length ? (
          <div className="sidebar-empty">
            <strong>No sessions yet</strong>
            <span>Create a New chat to start a Pixiu workbench session.</span>
          </div>
        ) : !filteredSessions.length ? (
          <div className="sidebar-empty">
            <strong>No matching sessions</strong>
            <span>Try a different search term.</span>
          </div>
        ) : (
          <div className="session-list">
            {filteredSessions.map((session) => (
              <button
                className={`session ${session.id === sessionId ? "active" : ""}`}
                key={session.id}
                title={`${session.title ?? session.id}\n${session.cwd}`}
                onClick={() => onLoadSession(session.id)}
              >
                <span className="session-name">{session.title ?? "Untitled chat"}</span>
                <span className="session-meta">{shortDate(session.updatedAt)}{session.workspaceDir ? ` · ${session.workspaceDir}` : ""}</span>
                <span className="session-context">{pathBasename(session.cwd) || session.cwd}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="rail-avatar">P</div>
        <div className="status-card">
          <div className="status-row">
            <span><span className={`dot ${providerReady ? "ok" : "warn"}`} />Provider</span>
            <span>{providerReady ? "ready" : "missing key"}</span>
          </div>
          <div className="status-row">
            <span>Workspace</span>
            <span>{workspace ?? "loading"}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}

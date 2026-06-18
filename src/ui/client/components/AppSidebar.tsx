import { useMemo, useState } from "react"

import type { UiProjectSummary, UiSessionSummary } from "../../shared/api"
import type { StatusSummary, WorkbenchPanel } from "../types"
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
  projects,
  currentProjectId,
  skillCount,
  activePanel,
  sessionId,
  providerReady,
  workspace,
  status,
  sessionsLoading,
  sessionsError,
  collapsed,
  onToggleCollapsed,
  onNewChat,
  onOpenPanel,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onRemoveProjectEntry,
  onRenameSession,
  onRemoveSessionFromList,
  onMoveSession,
  onConfigureApi,
  onLoadSession,
}: {
  sessions: UiSessionSummary[]
  projects: UiProjectSummary[]
  currentProjectId: string | undefined
  skillCount: number
  activePanel: WorkbenchPanel
  sessionId: string | undefined
  providerReady: boolean
  workspace: string | undefined
  status: StatusSummary | undefined
  sessionsLoading: boolean
  sessionsError: string | undefined
  collapsed: boolean
  onToggleCollapsed(): void
  onNewChat(): void
  onOpenPanel(panel: WorkbenchPanel): void
  onSelectProject(projectId: string): void
  onCreateProject(input: { name: string; rootPath?: string }): void
  onRenameProject(projectId: string, name: string): void
  onRemoveProjectEntry(projectId: string): void
  onRenameSession(sessionId: string, title: string): void
  onRemoveSessionFromList(sessionId: string): void
  onMoveSession(sessionId: string, projectId: string): void
  onConfigureApi(): void
  onLoadSession(sessionId: string): void
}) {
  const [query, setQuery] = useState("")
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState("")
  const [newProjectRoot, setNewProjectRoot] = useState("")
  const [editingProjectId, setEditingProjectId] = useState<string>()
  const [editingProjectName, setEditingProjectName] = useState("")
  const [confirmRemoveProjectId, setConfirmRemoveProjectId] = useState<string>()
  const [editingSessionId, setEditingSessionId] = useState<string>()
  const [editingSessionTitle, setEditingSessionTitle] = useState("")
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string>()
  const normalizedQuery = query.trim().toLowerCase()
  const activeProject = projects.find((project) => project.id === currentProjectId) ?? projects[0]
  const activeProjectPath = activeProject?.rootPath ?? status?.cwd ?? workspace
  const activeProjectName = activeProject?.name ?? (pathBasename(activeProjectPath) || "Project")
  const filteredSessions = useMemo(() => {
    const projectSessions = currentProjectId ? sessions.filter((session) => session.projectId === currentProjectId) : sessions
    if (!normalizedQuery) return projectSessions
    return projectSessions.filter((session) =>
      [
        session.title ?? "Untitled chat",
        session.preview ?? "",
        session.workspaceDir ?? "",
        session.cwd,
        session.model ?? "",
        session.finishStatus ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    )
  }, [currentProjectId, normalizedQuery, sessions])
  const mcpConnected = status?.mcp?.connected ?? 0
  const mcpConfigured = status?.mcp?.configured ?? 0

  function submitNewProject() {
    const name = newProjectName.trim()
    if (!name) return
    onCreateProject({ name, ...(newProjectRoot.trim() ? { rootPath: newProjectRoot.trim() } : {}) })
    setCreatingProject(false)
    setNewProjectName("")
    setNewProjectRoot("")
  }

  function startProjectRename(project: UiProjectSummary) {
    setEditingProjectId(project.id)
    setEditingProjectName(project.name)
    setConfirmRemoveProjectId(undefined)
  }

  function submitProjectRename(projectId: string) {
    const name = editingProjectName.trim()
    if (!name) return
    onRenameProject(projectId, name)
    setEditingProjectId(undefined)
    setEditingProjectName("")
  }

  function startSessionRename(session: UiSessionSummary) {
    setEditingSessionId(session.id)
    setEditingSessionTitle(session.title ?? "Untitled chat")
    setConfirmDeleteSessionId(undefined)
  }

  function submitSessionRename(id: string) {
    const title = editingSessionTitle.trim()
    if (!title) return
    onRenameSession(id, title)
    setEditingSessionId(undefined)
    setEditingSessionTitle("")
  }

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
          <button className={`nav-item ${activePanel === "projects" ? "active" : ""}`} type="button" title={activeProjectPath ?? "Current workspace root"} onClick={() => onOpenPanel("projects")}>
            <span className="nav-icon">P</span>
            <span className="nav-label">Projects</span>
            <span className="nav-meta">{activeProjectName}</span>
          </button>
          <button className={`nav-item ${activePanel === "skills" ? "active" : ""}`} type="button" title="Skills" onClick={() => onOpenPanel("skills")}>
            <span className="nav-icon">S</span>
            <span className="nav-label">Skills</span>
            <span className="nav-count">{skillCount}</span>
          </button>
          <button className={`nav-item ${activePanel === "mcp" ? "active" : ""}`} type="button" title="MCP status" onClick={() => onOpenPanel("mcp")}>
            <span className="nav-icon">M</span>
            <span className="nav-label">MCP</span>
            <span className="nav-count">{mcpConnected}/{mcpConfigured}</span>
          </button>
          <button className={`nav-item ${activePanel === "workspace" ? "active" : ""}`} type="button" title={workspace ?? "Workspace"} onClick={() => onOpenPanel("workspace")}>
            <span className="nav-icon">W</span>
            <span className="nav-label">Workspace</span>
          </button>
          <button className={`nav-item ${activePanel === "settings" ? "active" : ""}`} type="button" title="Settings / API" onClick={() => onOpenPanel("settings")}>
            <span className="nav-icon">A</span>
            <span className="nav-label">Settings / API</span>
            <span className={`nav-status ${providerReady ? "ok" : "warn"}`} />
          </button>
        </div>
        <div className="side-title">Projects</div>
        <div className="project-list">
          {projects.map((project) => (
            <div className={`project-card project-row ${project.id === currentProjectId ? "active" : ""}`} key={project.id} title={project.rootPath}>
              <button className="project-main" type="button" onClick={() => onSelectProject(project.id)}>
                <span className="project-name">{project.name}</span>
                <span className="project-path">{project.sessionCount} sessions · Workspace root: {project.rootPath}</span>
              </button>
              {editingProjectId === project.id ? (
                <div className="inline-edit">
                  <input
                    value={editingProjectName}
                    autoFocus
                    onChange={(event) => setEditingProjectName(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitProjectRename(project.id)
                      if (event.key === "Escape") setEditingProjectId(undefined)
                    }}
                  />
                  <div className="inline-actions">
                    <button type="button" onClick={() => submitProjectRename(project.id)}>Save</button>
                    <button type="button" onClick={() => setEditingProjectId(undefined)}>Cancel</button>
                  </div>
                </div>
              ) : confirmRemoveProjectId === project.id ? (
                <div className="confirm-box">
                  <span>Remove this empty project entry only. Files and folders stay on disk.</span>
                  <div className="inline-actions">
                    <button type="button" onClick={() => { onRemoveProjectEntry(project.id); setConfirmRemoveProjectId(undefined) }}>Remove</button>
                    <button type="button" onClick={() => setConfirmRemoveProjectId(undefined)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="inline-actions">
                  <button type="button" onClick={() => startProjectRename(project)}>Rename</button>
                  <button
                    type="button"
                    disabled={project.sessionCount > 0}
                    title={project.sessionCount > 0 ? "Move or remove sessions before removing this project entry." : "Remove empty project metadata only."}
                    onClick={() => setConfirmRemoveProjectId(project.id)}
                  >
                    Remove empty
                  </button>
                </div>
              )}
            </div>
          ))}
          {creatingProject ? (
            <div className="project-card project-create-form">
              <input value={newProjectName} autoFocus placeholder="Project name" onChange={(event) => setNewProjectName(event.currentTarget.value)} />
              <input value={newProjectRoot} placeholder="Workspace root, optional" onChange={(event) => setNewProjectRoot(event.currentTarget.value)} />
              <span className="form-hint">Leaving root blank uses the current Pixiu workspace. Removing a project later only removes metadata.</span>
              <div className="inline-actions">
                <button type="button" onClick={submitNewProject}>Create</button>
                <button type="button" onClick={() => { setCreatingProject(false); setNewProjectName(""); setNewProjectRoot("") }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="side-mini-action" type="button" onClick={() => setCreatingProject(true)}>New project</button>
          )}
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
            <strong>No sessions match your search.</strong>
            <span>Try a different term or project.</span>
          </div>
        ) : (
          <div className="session-list">
            {filteredSessions.map((session) => (
              <div className={`session-row ${session.id === sessionId ? "active" : ""}`} key={session.id}>
                <button
                  className="session"
                  title={`${session.title ?? session.id}\n${session.cwd}`}
                  onClick={() => { onOpenPanel("chat"); onLoadSession(session.id) }}
                >
                  <span className="session-name">{session.title ?? "Untitled chat"}</span>
                  <span className="session-meta">{shortDate(session.updatedAt)}{session.workspaceDir ? ` · ${session.workspaceDir}` : ""}</span>
                  <span className="session-context">{session.preview ?? (pathBasename(session.cwd) || session.cwd)}</span>
                </button>
                <div className="inline-actions session-actions">
                  {editingSessionId === session.id ? (
                    <>
                      <input
                        value={editingSessionTitle}
                        autoFocus
                        onChange={(event) => setEditingSessionTitle(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") submitSessionRename(session.id)
                          if (event.key === "Escape") setEditingSessionId(undefined)
                        }}
                      />
                      <button type="button" onClick={() => submitSessionRename(session.id)}>Save</button>
                      <button type="button" onClick={() => setEditingSessionId(undefined)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => startSessionRename(session)}>Rename</button>
                  )}
                  {projects.length > 1 ? (
                    <select
                      value={session.projectId ?? ""}
                      title="Move to project"
                      onChange={(event) => onMoveSession(session.id, event.currentTarget.value)}
                    >
                      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  ) : null}
                  {confirmDeleteSessionId === session.id ? (
                    <>
                      <button type="button" onClick={() => { onRemoveSessionFromList(session.id); setConfirmDeleteSessionId(undefined) }}>Remove from list</button>
                      <button type="button" onClick={() => setConfirmDeleteSessionId(undefined)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDeleteSessionId(session.id)}>Remove</button>
                  )}
                </div>
              </div>
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

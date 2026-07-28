import {
  Check,
  ChevronRight,
  Files,
  FolderGit2,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"

import type { UiProjectSummary, UiSessionSummary } from "../../shared/api"
import { pathBasename, shortDate } from "../helpers"
import type { StatusSummary, WorkbenchPanel } from "../types"
import { WORKBENCH_NAVIGATION_ID, WORKBENCH_NAVIGATION_TRIGGER_ID } from "./WorkbenchLayout"

const MOBILE_DRAWER_QUERY = "(max-width: 1050px)"
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

function useMobileDrawer() {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_DRAWER_QUERY).matches)

  useEffect(() => {
    const query = window.matchMedia(MOBILE_DRAWER_QUERY)
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return mobile
}

function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true")
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
  mobileOpen,
  onToggleCollapsed,
  onCloseMobileNav,
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
  onBrowseFolder,
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
  mobileOpen: boolean
  onToggleCollapsed(): void
  onCloseMobileNav(): void
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
  onBrowseFolder?(): Promise<string | undefined>
}) {
  const [query, setQuery] = useState("")
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState("")
  const [newProjectRoot, setNewProjectRoot] = useState("")
  const [editingProjectId, setEditingProjectId] = useState<string>()
  const [editingProjectName, setEditingProjectName] = useState("")
  const [editingSessionId, setEditingSessionId] = useState<string>()
  const [editingSessionTitle, setEditingSessionTitle] = useState("")
  const isMobileDrawer = useMobileDrawer()
  const sidebarRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const activeProject = projects.find((project) => project.id === currentProjectId) ?? projects[0]
  const filteredSessions = useMemo(() => {
    const projectSessions = currentProjectId ? sessions.filter((session) => session.projectId === currentProjectId) : sessions
    if (!normalizedQuery) return projectSessions
    return projectSessions.filter((session) => `${session.title ?? ""} ${session.preview ?? ""} ${session.cwd}`.toLowerCase().includes(normalizedQuery))
  }, [currentProjectId, normalizedQuery, sessions])

  useEffect(() => {
    if (!isMobileDrawer || !mobileOpen) return
    const activeElement = document.activeElement
    const restoreFocus = activeElement instanceof HTMLElement && !sidebarRef.current?.contains(activeElement)
      ? activeElement
      : document.getElementById(WORKBENCH_NAVIGATION_TRIGGER_ID)
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())

    return () => {
      window.cancelAnimationFrame(frame)
      if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus()
    }
  }, [isMobileDrawer, mobileOpen])

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!isMobileDrawer || !mobileOpen) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onCloseMobileNav()
      return
    }
    if (event.key !== "Tab" || !sidebarRef.current) return
    const focusable = focusableElements(sidebarRef.current)
    if (!focusable.length) {
      event.preventDefault()
      sidebarRef.current.focus()
      return
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey
      ? currentIndex <= 0 ? focusable.at(-1) : undefined
      : currentIndex === -1 || currentIndex === focusable.length - 1 ? focusable[0] : undefined
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  function navigate(action: () => void) {
    action()
    onCloseMobileNav()
  }

  function submitProject() {
    const name = newProjectName.trim()
    if (!name) return
    onCreateProject({ name, ...(newProjectRoot.trim() ? { rootPath: newProjectRoot.trim() } : {}) })
    setCreatingProject(false)
    setNewProjectName("")
    setNewProjectRoot("")
  }

  return (
    <aside
      className={`sidebar workbench-sidebar ${mobileOpen ? "mobile-open" : ""}`}
      id={WORKBENCH_NAVIGATION_ID}
      ref={sidebarRef}
      role={isMobileDrawer ? "dialog" : undefined}
      aria-label="Pixiu navigation"
      aria-modal={isMobileDrawer && mobileOpen ? true : undefined}
      aria-hidden={isMobileDrawer && !mobileOpen ? true : undefined}
      inert={isMobileDrawer && !mobileOpen ? true : undefined}
      tabIndex={isMobileDrawer ? -1 : undefined}
      onKeyDown={handleDrawerKeyDown}
    >
      <header className="brand">
        <div className="brand-mark" aria-hidden="true"><Sparkles /></div>
        <div className="brand-copy">
          <strong>Pixiu</strong>
          <span>{activeProject?.name ?? "Local agent"}</span>
        </div>
        <button className="icon-button sidebar-toggle" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapsed}>
          {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </button>
        <button ref={closeButtonRef} className="icon-button mobile-nav-close" type="button" aria-label="Close navigation" title="Close navigation" onClick={onCloseMobileNav}><X aria-hidden="true" /></button>
      </header>

      <div className="sidebar-primary">
        <button className="new-chat-button" type="button" aria-label="New chat" title="New chat" onClick={() => navigate(onNewChat)}>
          <SquarePen aria-hidden="true" />
          <span>New chat</span>
        </button>
        <label className="sidebar-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search sessions</span>
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search sessions" aria-label="Search sessions" />
        </label>
      </div>

      <div className="sidebar-scroll">
        <section className="sidebar-group" aria-labelledby="projects-heading">
          <div className="sidebar-group-head">
            <span id="projects-heading">Projects</span>
            <button className="mini-icon-button" type="button" aria-label="New project" title="New project" onClick={() => setCreatingProject(true)}><Plus aria-hidden="true" /></button>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <div className={`sidebar-row project-row ${project.id === currentProjectId ? "active" : ""}`} key={project.id}>
                <button className="sidebar-row-main" type="button" title={project.rootPath} onClick={() => navigate(() => onSelectProject(project.id))}>
                  <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                  <span className="sidebar-row-copy">
                    <strong>{project.name}</strong>
                    <small>{project.sessionCount} sessions</small>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
                <details className="row-menu">
                  <summary aria-label={`Project actions for ${project.name}`} title="Project actions"><MoreHorizontal aria-hidden="true" /></summary>
                  <div className="row-menu-popover">
                    {editingProjectId === project.id ? (
                      <form onSubmit={(event) => { event.preventDefault(); if (!editingProjectName.trim()) return; onRenameProject(project.id, editingProjectName.trim()); setEditingProjectId(undefined) }}>
                        <input value={editingProjectName} autoFocus aria-label="Project name" onChange={(event) => setEditingProjectName(event.currentTarget.value)} />
                        <button type="submit" aria-label="Save project name"><Check aria-hidden="true" /> Save</button>
                      </form>
                    ) : (
                      <button type="button" onClick={() => { setEditingProjectId(project.id); setEditingProjectName(project.name) }}><Pencil aria-hidden="true" /> Rename</button>
                    )}
                    <button type="button" className="danger-menu-item" disabled={project.sessionCount > 0} title={project.sessionCount ? "Remove sessions first" : "Remove project metadata"} onClick={() => onRemoveProjectEntry(project.id)}><Trash2 aria-hidden="true" /> Remove</button>
                  </div>
                </details>
              </div>
            ))}
            {creatingProject ? (
              <form className="project-create-form" onSubmit={(event) => { event.preventDefault(); submitProject() }}>
                <input value={newProjectName} autoFocus placeholder="Project name" aria-label="Project name" onChange={(event) => setNewProjectName(event.currentTarget.value)} />
                <div className="inline-field">
                  <input value={newProjectRoot} placeholder="Workspace root (optional)" aria-label="Workspace root" onChange={(event) => setNewProjectRoot(event.currentTarget.value)} />
                  {onBrowseFolder ? (
                    <button type="button" onClick={async () => { const picked = await onBrowseFolder(); if (picked) setNewProjectRoot(picked) }}>Browse...</button>
                  ) : null}
                </div>
                <span className="form-hint">Choose an existing local folder. Pixiu works in an isolated session copy; reviewed changes reach the folder only after Apply.</span>
                <div className="inline-actions">
                  <button type="submit">Create</button>
                  <button type="button" onClick={() => { setCreatingProject(false); setNewProjectName(""); setNewProjectRoot("") }}>Cancel</button>
                </div>
              </form>
            ) : null}
          </div>
        </section>

        <section className="sidebar-group sessions-group" aria-labelledby="sessions-heading">
          <div className="sidebar-group-head"><span id="sessions-heading">Recent sessions</span><small>{filteredSessions.length}</small></div>
          {sessionsLoading ? <div className="sidebar-empty">Loading sessions...</div> : null}
          {sessionsError ? <div className="sidebar-empty error" role="alert">{sessionsError}</div> : null}
          {!sessionsLoading && !sessionsError && !filteredSessions.length ? <div className="sidebar-empty">No sessions in this project.</div> : null}
          <div className="session-list">
            {filteredSessions.map((session) => (
              <div className={`sidebar-row session-row ${session.id === sessionId ? "active" : ""}`} key={session.id}>
                <button className="sidebar-row-main session" type="button" title={`${session.title ?? session.id}\n${session.cwd}`} onClick={() => navigate(() => { onOpenPanel("chat"); onLoadSession(session.id) })}>
                  <span className={`session-status session-status-${session.finishStatus ?? "idle"}`} aria-hidden="true" />
                  <span className="sidebar-row-copy">
                    <strong>{session.title ?? "Untitled chat"}</strong>
                    <small>{shortDate(session.updatedAt)}{session.preview ? ` · ${session.preview}` : ""}</small>
                  </span>
                </button>
                <details className="row-menu">
                  <summary aria-label={`Session actions for ${session.title ?? "Untitled chat"}`} title="Session actions"><MoreHorizontal aria-hidden="true" /></summary>
                  <div className="row-menu-popover">
                    {editingSessionId === session.id ? (
                      <form onSubmit={(event) => { event.preventDefault(); if (!editingSessionTitle.trim()) return; onRenameSession(session.id, editingSessionTitle.trim()); setEditingSessionId(undefined) }}>
                        <input value={editingSessionTitle} autoFocus aria-label="Session title" onChange={(event) => setEditingSessionTitle(event.currentTarget.value)} />
                        <button type="submit"><Check aria-hidden="true" /> Save</button>
                      </form>
                    ) : (
                      <button type="button" onClick={() => { setEditingSessionId(session.id); setEditingSessionTitle(session.title ?? "Untitled chat") }}><Pencil aria-hidden="true" /> Rename</button>
                    )}
                    {projects.length > 1 ? (
                      <label className="move-session-label">Move to<select value={session.projectId ?? ""} onChange={(event) => onMoveSession(session.id, event.currentTarget.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
                    ) : null}
                    <button type="button" className="danger-menu-item" onClick={() => onRemoveSessionFromList(session.id)}><Trash2 aria-hidden="true" /> Remove from list</button>
                  </div>
                </details>
              </div>
            ))}
          </div>
        </section>
      </div>

      <nav className="sidebar-footer" aria-label="Workbench sections">
        <button className={activePanel === "workspace" ? "active" : ""} type="button" aria-label="Workspace" title={workspace ?? "Workspace"} onClick={() => navigate(() => onOpenPanel("workspace"))}><Files aria-hidden="true" /><span>Workspace</span></button>
        <button className={activePanel === "skills" ? "active" : ""} type="button" aria-label="Skills" title="Skills" onClick={() => navigate(() => onOpenPanel("skills"))}><Puzzle aria-hidden="true" /><span>Skills</span><small>{skillCount}</small></button>
        <button className={activePanel === "mcp" ? "active" : ""} type="button" aria-label="MCP" title="MCP" onClick={() => navigate(() => onOpenPanel("mcp"))}><Network aria-hidden="true" /><span>MCP</span><small>{status?.mcp?.connected ?? 0}/{status?.mcp?.configured ?? 0}</small></button>
        <button className={activePanel === "projects" ? "active" : ""} type="button" aria-label="Projects" title="Projects" onClick={() => navigate(() => onOpenPanel("projects"))}><FolderGit2 aria-hidden="true" /><span>Projects</span></button>
        <button className={activePanel === "settings" ? "active" : ""} type="button" aria-label="Settings" title="Settings" onClick={() => navigate(() => { onOpenPanel("settings"); onConfigureApi() })}><Settings aria-hidden="true" /><span>Settings</span><span className={`provider-dot ${providerReady ? "ok" : "warn"}`} /></button>
      </nav>
    </aside>
  )
}

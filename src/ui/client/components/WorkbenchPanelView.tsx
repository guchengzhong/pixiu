import type { SessionEvidence } from "../../../session/evidence"
import { useState } from "react"
import type { UiFileSummary } from "../../shared/api"
import { formatSize, pathBasename, shortDate } from "../helpers"
import type {
  FilePreview,
  FileReferenceSource,
  StatusSummary,
  UiMcpServerSummary,
  UiProjectSummary,
  UiSessionSummary,
  UiSkillSummary,
  WorkbenchPanel,
} from "../types"
import { StatusPanel } from "./StatusPanel"
import { WorkspaceFiles } from "./WorkspaceFiles"

export function WorkbenchPanelView({
  panel,
  projects,
  currentProjectId,
  sessions,
  skills,
  mcpServers,
  files,
  preview,
  evidence,
  status,
  providerReady,
  onCreateProject,
  onRenameProject,
  onRemoveProjectEntry,
  onSelectProject,
  onCreateSession,
  onLoadSession,
  onRenameSession,
  onRemoveSessionFromList,
  onMoveSession,
  onPreviewFile,
  onReferenceFile,
  onConfigureApi,
  onRefresh,
}: {
  panel: Exclude<WorkbenchPanel, "chat">
  projects: UiProjectSummary[]
  currentProjectId: string | undefined
  sessions: UiSessionSummary[]
  skills: UiSkillSummary[]
  mcpServers: UiMcpServerSummary[]
  files: UiFileSummary[]
  preview: FilePreview | undefined
  evidence: SessionEvidence | undefined
  status: StatusSummary | undefined
  providerReady: boolean
  onCreateProject(input: { name: string; rootPath?: string }): void
  onRenameProject(projectId: string, name: string): void
  onRemoveProjectEntry(projectId: string): void
  onSelectProject(projectId: string): void
  onCreateSession(): void
  onLoadSession(sessionId: string): void
  onRenameSession(sessionId: string, title: string): void
  onRemoveSessionFromList(sessionId: string): void
  onMoveSession(sessionId: string, projectId: string): void
  onPreviewFile(file: UiFileSummary): void
  onReferenceFile(file: UiFileSummary, source: FileReferenceSource): void
  onConfigureApi(): void
  onRefresh(): void
}) {
  return (
    <div className="workbench-panel-view">
      {panel === "projects" ? (
        <ProjectsPanel
          projects={projects}
          currentProjectId={currentProjectId}
          sessions={sessions}
          onCreateProject={onCreateProject}
          onRenameProject={onRenameProject}
          onRemoveProjectEntry={onRemoveProjectEntry}
          onSelectProject={onSelectProject}
          onCreateSession={onCreateSession}
          onLoadSession={onLoadSession}
          onRenameSession={onRenameSession}
          onRemoveSessionFromList={onRemoveSessionFromList}
          onMoveSession={onMoveSession}
        />
      ) : null}
      {panel === "skills" ? <SkillsPanel skills={skills} onRefresh={onRefresh} /> : null}
      {panel === "mcp" ? <McpPanel servers={mcpServers} onRefresh={onRefresh} /> : null}
      {panel === "workspace" ? (
        <PanelFrame title="Workspace" meta={status?.cwd ?? "Project workspace"} action={<button className="ghost" type="button" onClick={onRefresh}>Refresh</button>}>
          <WorkspaceFiles files={files} preview={preview} evidence={evidence} onPreview={onPreviewFile} onReference={onReferenceFile} />
        </PanelFrame>
      ) : null}
      {panel === "settings" ? (
        <PanelFrame title="Settings / API" meta={providerReady ? "API ready" : "API key missing"} action={<button className="ghost" type="button" onClick={onConfigureApi}>Configure API</button>}>
          <StatusPanel status={status} />
        </PanelFrame>
      ) : null}
    </div>
  )
}

function ProjectsPanel({
  projects,
  currentProjectId,
  sessions,
  onCreateProject,
  onRenameProject,
  onRemoveProjectEntry,
  onSelectProject,
  onCreateSession,
  onLoadSession,
  onRenameSession,
  onRemoveSessionFromList,
  onMoveSession,
}: {
  projects: UiProjectSummary[]
  currentProjectId: string | undefined
  sessions: UiSessionSummary[]
  onCreateProject(input: { name: string; rootPath?: string }): void
  onRenameProject(projectId: string, name: string): void
  onRemoveProjectEntry(projectId: string): void
  onSelectProject(projectId: string): void
  onCreateSession(): void
  onLoadSession(sessionId: string): void
  onRenameSession(sessionId: string, title: string): void
  onRemoveSessionFromList(sessionId: string): void
  onMoveSession(sessionId: string, projectId: string): void
}) {
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState("")
  const [newProjectRoot, setNewProjectRoot] = useState("")
  const [editingProjectId, setEditingProjectId] = useState<string>()
  const [editingProjectName, setEditingProjectName] = useState("")
  const [confirmRemoveProjectId, setConfirmRemoveProjectId] = useState<string>()
  const [editingSessionId, setEditingSessionId] = useState<string>()
  const [editingSessionTitle, setEditingSessionTitle] = useState("")
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string>()
  const activeProject = projects.find((project) => project.id === currentProjectId) ?? projects[0]
  const projectSessions = activeProject ? sessions.filter((session) => session.projectId === activeProject.id) : sessions

  function submitNewProject() {
    const name = newProjectName.trim()
    if (!name) return
    onCreateProject({ name, ...(newProjectRoot.trim() ? { rootPath: newProjectRoot.trim() } : {}) })
    setNewProjectOpen(false)
    setNewProjectName("")
    setNewProjectRoot("")
  }

  function submitProjectRename(projectId: string) {
    const name = editingProjectName.trim()
    if (!name) return
    onRenameProject(projectId, name)
    setEditingProjectId(undefined)
    setEditingProjectName("")
  }

  function submitSessionRename(sessionId: string) {
    const title = editingSessionTitle.trim()
    if (!title) return
    onRenameSession(sessionId, title)
    setEditingSessionId(undefined)
    setEditingSessionTitle("")
  }

  return (
    <PanelFrame title="Projects" meta={activeProject ? `${activeProject.name} · Workspace root: ${activeProject.rootPath}` : "No project selected"} action={<button className="ghost" type="button" onClick={() => setNewProjectOpen(true)}>New project</button>}>
      <div className="panel-grid">
        <section className="panel-section">
          <div className="panel-section-head">
            <strong>Project List</strong>
            <span>{projects.length}</span>
          </div>
          {newProjectOpen ? (
            <div className="panel-row project-create-form">
              <input value={newProjectName} autoFocus placeholder="Project name" onChange={(event) => setNewProjectName(event.currentTarget.value)} />
              <input value={newProjectRoot} placeholder="Workspace root, optional" onChange={(event) => setNewProjectRoot(event.currentTarget.value)} />
              <small>Leaving root blank uses the current Pixiu workspace. This creates a Pixiu grouping entry, not a folder.</small>
              <div className="panel-row-actions">
                <button type="button" onClick={submitNewProject}>Create</button>
                <button type="button" onClick={() => { setNewProjectOpen(false); setNewProjectName(""); setNewProjectRoot("") }}>Cancel</button>
              </div>
            </div>
          ) : null}
          {projects.map((project) => (
            <div className={`panel-row ${project.id === activeProject?.id ? "active" : ""}`} key={project.id}>
              <button className="panel-row-main" type="button" onClick={() => onSelectProject(project.id)}>
                <strong>{project.name}</strong>
                <span>{project.sessionCount} sessions · Workspace root: {project.rootPath}</span>
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
                  <div className="panel-row-actions">
                    <button type="button" onClick={() => submitProjectRename(project.id)}>Save</button>
                    <button type="button" onClick={() => setEditingProjectId(undefined)}>Cancel</button>
                  </div>
                </div>
              ) : confirmRemoveProjectId === project.id ? (
                <div className="confirm-box">
                  <span>Remove this empty Pixiu project entry only. Workspace root files stay on disk.</span>
                  <div className="panel-row-actions">
                    <button type="button" onClick={() => { onRemoveProjectEntry(project.id); setConfirmRemoveProjectId(undefined) }}>Remove</button>
                    <button type="button" onClick={() => setConfirmRemoveProjectId(undefined)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="panel-row-actions">
                  <button type="button" onClick={() => { setEditingProjectId(project.id); setEditingProjectName(project.name); setConfirmRemoveProjectId(undefined) }}>Rename</button>
                  <button type="button" onClick={() => void navigator.clipboard?.writeText(project.rootPath)}>Copy workspace root</button>
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
        </section>
        <section className="panel-section">
          <div className="panel-section-head">
            <strong>Sessions</strong>
            <span>{projectSessions.length}</span>
          </div>
          <button className="side-mini-action" type="button" onClick={onCreateSession}>New session in project</button>
          {projectSessions.length ? (
            projectSessions.map((session) => (
              <div className="panel-row" key={session.id}>
                <button className="panel-row-main" type="button" onClick={() => onLoadSession(session.id)}>
                  <strong>{session.title ?? "Untitled chat"}</strong>
                  <span>{shortDate(session.updatedAt)} · {session.preview ?? (pathBasename(session.cwd) || session.cwd)}</span>
                </button>
                <div className="panel-row-actions">
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
                    <button type="button" onClick={() => { setEditingSessionId(session.id); setEditingSessionTitle(session.title ?? "Untitled chat"); setConfirmDeleteSessionId(undefined) }}>Rename</button>
                  )}
                  {projects.length > 1 ? (
                    <select value={session.projectId ?? ""} onChange={(event) => onMoveSession(session.id, event.currentTarget.value)}>
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
            ))
          ) : (
            <div className="file-empty-state">No sessions in this project.</div>
          )}
        </section>
      </div>
    </PanelFrame>
  )
}

function SkillsPanel({ skills, onRefresh }: { skills: UiSkillSummary[]; onRefresh(): void }) {
  return (
    <PanelFrame title="Skills" meta={`${skills.length} installed`} action={<button className="ghost" type="button" onClick={onRefresh}>Refresh</button>}>
      <div className="panel-list">
        {skills.length ? (
          skills.map((skill) => (
            <div className="panel-row" key={skill.name}>
              <div className="panel-row-main as-copy">
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
                <small>{skill.skillPath} · {skill.referenceCount} references</small>
              </div>
              <div className="panel-row-actions">
                <button type="button" onClick={() => void navigator.clipboard?.writeText(skill.skillPath)}>Copy path</button>
              </div>
            </div>
          ))
        ) : (
          <div className="file-empty-state">No skills found. Create a SKILL.md file or configure skill paths.</div>
        )}
      </div>
    </PanelFrame>
  )
}

function McpPanel({ servers, onRefresh }: { servers: UiMcpServerSummary[]; onRefresh(): void }) {
  return (
    <PanelFrame title="MCP" meta={`${servers.length} configured`} action={<button className="ghost" type="button" onClick={onRefresh}>Refresh</button>}>
      <div className="panel-list">
        {servers.length ? (
          servers.map((server) => (
            <div className={`panel-row mcp-${server.status}`} key={server.name}>
              <div className="panel-row-main as-copy">
                <strong>{server.name}</strong>
                <span>{server.status} · {server.transport} · {server.tools} tools</span>
                <small>{server.command ?? server.url ?? (server.enabled ? "configured" : "disabled")}</small>
              </div>
              <div className="panel-row-actions">
                <button type="button" onClick={() => void navigator.clipboard?.writeText(server.command ?? server.url ?? server.name)}>Copy</button>
              </div>
            </div>
          ))
        ) : (
          <div className="file-empty-state">No MCP servers configured.</div>
        )}
      </div>
    </PanelFrame>
  )
}

function PanelFrame({ title, meta, action, children }: { title: string; meta?: string; action?: JSX.Element; children: JSX.Element }) {
  return (
    <section className="panel-frame">
      <div className="panel-frame-head">
        <div>
          <h2>{title}</h2>
          {meta ? <p>{meta}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

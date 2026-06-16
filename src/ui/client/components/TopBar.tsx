import type { TodoItem } from "../../../todo/types"
import { pathBasename } from "../helpers"
import { todoProgress } from "../todos"

export function TopBar({
  chatTitle,
  cwd,
  model,
  permissionMode,
  runStatus,
  providerReady,
  todos,
  currentTodoId,
  inspectorCollapsed,
  onOpenStatus,
  onOpenActivity,
  onConfigureApi,
}: {
  chatTitle: string
  cwd: string | undefined
  model: string | undefined
  permissionMode: string
  runStatus: string
  providerReady: boolean
  todos: TodoItem[]
  currentTodoId: string | undefined
  inspectorCollapsed: boolean
  onOpenStatus(): void
  onOpenActivity(): void
  onConfigureApi(): void
}) {
  const projectName = pathBasename(cwd) || "Project"
  const progress = todoProgress(todos, currentTodoId)
  return (
    <header className="topbar workbench-topbar">
      <div className="topbar-context">
        <div className="project-chip" title={cwd ?? "project"}>
          <span className="project-kicker">Project</span>
          <strong>{projectName}</strong>
        </div>
        <div className="conversation-title">
          <span className="topbar-label">Session</span>
          <strong title={chatTitle}>{chatTitle}</strong>
        </div>
      </div>
      <div className="topbar-status">
        <span className="pill topbar-path" title={cwd ?? "project"}>{cwd ?? "project"}</span>
        <span className="pill" title="Current model">{model ?? "model"}</span>
        <span className="pill" title="Permission mode">{permissionMode}</span>
        <span className="pill" title="Run status">{runStatus}</span>
        {progress.total ? (
          <span className="pill current-task" title={progress.current?.content ?? "Task progress"}>
            {progress.completed}/{progress.total} tasks
          </span>
        ) : null}
        <span className={`pill ${providerReady ? "ok" : "warn"}`}>{providerReady ? "API ready" : "API key missing"}</span>
      </div>
      <div className="top-actions">
        <button className="ghost" onClick={onOpenStatus}>Status</button>
        <button className="ghost" onClick={onOpenActivity}>Activity</button>
        {inspectorCollapsed ? <button className="ghost inspector-toggle" onClick={onOpenActivity}>Inspector</button> : null}
        <button className="ghost" onClick={onConfigureApi}>API</button>
      </div>
    </header>
  )
}

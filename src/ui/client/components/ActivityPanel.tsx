import type { SessionEvidence } from "../../../session/evidence"
import type { TodoItem } from "../../../todo/types"
import type { UiFileSummary } from "../../shared/api"
import type { ActivityItem, FilePreview, FileReferenceSource, InspectorTab, StatusSummary, TraceItem } from "../types"
import { EvidencePanel } from "./EvidencePanel"
import { ExecutionTimeline } from "./ExecutionTimeline"
import { SemanticActivityList } from "./SemanticActivityList"
import { StatusPanel } from "./StatusPanel"
import { TodoProgress } from "./TodoProgress"
import { WorkspaceFiles } from "./WorkspaceFiles"

export function ActivityPanel(props: {
  open: boolean
  collapsed: boolean
  activeTab: InspectorTab
  setActiveTab(tab: InspectorTab): void
  close(): void
  trace: TraceItem[]
  activity: ActivityItem[]
  files: UiFileSummary[]
  preview: FilePreview | undefined
  evidence: SessionEvidence | undefined
  status: StatusSummary | undefined
  todos: TodoItem[]
  currentTodoId: string | undefined
  onPreview(file: UiFileSummary): void
  onReference(file: UiFileSummary, source: FileReferenceSource): void
}) {
  return (
    <aside className={`workspace-panel workbench-inspector ${props.open ? "open" : ""} ${props.collapsed ? "inspector-collapsed-panel" : ""}`}>
      <div className="inspect-head">
        <strong>Activity</strong>
        <button className="icon-button inspector-toggle inspector-close" type="button" title="Close inspector" onClick={props.close}>x</button>
      </div>
      <div className="tabs">
        {(["trace", "files", "evidence", "status"] as const).map((tab) => (
          <button className={`tab ${props.activeTab === tab ? "active" : ""}`} type="button" key={tab} onClick={() => props.setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {props.activeTab === "trace" ? (
          <div className="activity-tab">
            <TodoProgress todos={props.todos} currentTodoId={props.currentTodoId} />
            {props.activity.length ? (
              <>
                <SemanticActivityList activity={props.activity} />
                <details className="raw-trace-disclosure">
                  <summary>Raw Details</summary>
                  <ExecutionTimeline trace={props.trace} />
                </details>
              </>
            ) : (
              <ExecutionTimeline trace={props.trace} />
            )}
          </div>
        ) : null}
        {props.activeTab === "files" ? (
          <WorkspaceFiles
            files={props.files}
            preview={props.preview}
            evidence={props.evidence}
            onPreview={props.onPreview}
            onReference={props.onReference}
          />
        ) : null}
        {props.activeTab === "evidence" ? <EvidencePanel evidence={props.evidence} /> : null}
        {props.activeTab === "status" ? <StatusPanel status={props.status} /> : null}
      </div>
    </aside>
  )
}

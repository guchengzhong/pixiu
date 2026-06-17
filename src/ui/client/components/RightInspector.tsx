import type { SessionEvidence } from "../../../session/evidence"
import type { TodoItem } from "../../../todo/types"
import type { UiFileSummary } from "../../shared/api"
import type { ActivityItem, FilePreview, FileReferenceSource, InspectorTab, StatusSummary, TraceItem } from "../types"
import { ActivityPanel } from "./ActivityPanel"

export function RightInspector(props: {
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
  return <ActivityPanel {...props} />
}

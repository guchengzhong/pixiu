import type { SessionEvidence } from "../../../session/evidence"
import type { SessionTurn } from "../../../session/types"
import type { TodoItem } from "../../../todo/types"
import type { UiFileSummary, UiValidationRecord } from "../../shared/api"
import type { ActivityItem, FilePreview, FileReferenceRange, FileReferenceSource, InspectorTab, StatusSummary, TraceItem } from "../types"
import { ActivityPanel } from "./ActivityPanel"

export function RightInspector(props: {
  open: boolean
  collapsed: boolean
  inspectorWidth: number
  currentProjectId: string | undefined
  sessionId: string | undefined
  activeTab: InspectorTab
  setActiveTab(tab: InspectorTab): void
  close(): void
  trace: TraceItem[]
  activity: ActivityItem[]
  files: UiFileSummary[]
  preview: FilePreview | undefined
  evidence: SessionEvidence | undefined
  turns: SessionTurn[]
  validations: UiValidationRecord[]
  status: StatusSummary | undefined
  todos: TodoItem[]
  currentTodoId: string | undefined
  onPreview(file: UiFileSummary): void
  onReference(file: UiFileSummary, source: FileReferenceSource, range?: FileReferenceRange): void
  onValidationsChange(validations: UiValidationRecord[]): void
  onFixValidation(record: UiValidationRecord): void
  onResize(width: number): void
}) {
  return <ActivityPanel {...props} />
}

import type { SessionEvidence } from "../../../session/evidence"
import type { TodoItem } from "../../../todo/types"
import type { RunStatus } from "../../../run/status"
import type { UiFileSummary } from "../../shared/api"
import { isPrimaryActivity } from "../activity"
import { fileNameFromPath } from "../helpers"
import { todoProgress } from "../todos"
import type { ActivityItem, ChatMessage, FileReference, InspectorTab, TraceItem } from "../types"

type StructuredCardsProps = {
  messages: ChatMessage[]
  files: UiFileSummary[]
  composerReferences: FileReference[]
  trace: TraceItem[]
  activity: ActivityItem[]
  evidence: SessionEvidence | undefined
  todos: TodoItem[]
  currentTodoId: string | undefined
  runStatus: RunStatus
  runStatusLabel: string
  runId: string | undefined
  permissionMode: string
  onOpenInspector(tab: InspectorTab): void
  onPreviewFile(file: UiFileSummary): void
}

export function StructuredCards({
  messages,
  files,
  composerReferences,
  trace,
  activity,
  evidence,
  todos,
  currentTodoId,
  runStatus,
  runStatusLabel,
  runId,
  permissionMode,
  onOpenInspector,
  onPreviewFile,
}: StructuredCardsProps) {
  const referencedFiles = referencedFileSummaries(messages, composerReferences, files)
  const toolSummary = summarizeTools(trace, activity)
  const artifacts = evidence?.artifacts ?? []
  const skills = skillNames(trace, activity)
  const failedTrace = trace.find((item) => item.failed)
  const progress = todoProgress(todos, currentTodoId)

  return (
    <div className="workbench-cards" aria-label="Agent workbench summary">
      <section className="workbench-card">
        <div className="card-head">
          <span>Files used</span>
          <strong>{referencedFiles.length}</strong>
        </div>
        {referencedFiles.length ? (
          <div className="card-list">
            {referencedFiles.slice(0, 4).map((file) => (
              <button className="card-row" type="button" key={file.path} onClick={() => onPreviewFile(file)}>
                <span className="card-row-title">{fileNameFromPath(file.path)}</span>
                <span>{file.path}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="card-empty">No referenced files in this message context.</div>
        )}
      </section>

      <section className="workbench-card">
        <div className="card-head">
          <span>Tools</span>
          <strong>{toolSummary.total}</strong>
        </div>
        {toolSummary.total ? (
          <button className="card-body-action" type="button" onClick={() => onOpenInspector("trace")}>
            <span>{toolSummary.names.join(", ")}</span>
            <small>{toolSummary.failed} failed · open Activity</small>
          </button>
        ) : (
          <button className="card-body-action muted" type="button" onClick={() => onOpenInspector("trace")}>
            <span>No tool calls yet</span>
            <small>Open Activity</small>
          </button>
        )}
      </section>

      <section className="workbench-card">
        <div className="card-head">
          <span>Artifacts</span>
          <strong>{artifacts.length}</strong>
        </div>
        {artifacts.length ? (
          <div className="card-list">
            {artifacts.slice(0, 4).map((artifact) => {
              const file = files.find((item) => item.path === artifact.path)
              return (
                <button
                  className="card-row"
                  type="button"
                  key={`${artifact.tool}:${artifact.path}`}
                  onClick={() => (file ? onPreviewFile(file) : onOpenInspector("evidence"))}
                >
                  <span className="card-row-title">{fileNameFromPath(artifact.path)}</span>
                  <span>{artifact.tool} · {artifact.path}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <button className="card-body-action muted" type="button" onClick={() => onOpenInspector("evidence")}>
            <span>No generated artifacts</span>
            <small>Open Evidence</small>
          </button>
        )}
      </section>

      <section className="workbench-card">
        <div className="card-head">
          <span>Progress</span>
          <strong className={runId ? "live" : progress.total && progress.completed === progress.total ? "ok" : failedTrace ? "bad" : ""}>
            {progress.total ? `${progress.completed}/${progress.total}` : runId ? runStatusLabel : "Ready"}
          </strong>
        </div>
        <button className="card-body-action" type="button" onClick={() => onOpenInspector("trace")}>
          <span title={progress.current?.content ?? runStatusLabel}>{progress.current?.content ?? runStatusLabel}</span>
          <small>{progress.total ? "open Activity progress" : `${permissionMode} · open Activity`}</small>
        </button>
      </section>

      <section className="workbench-card">
        <div className="card-head">
          <span>Skills</span>
          <strong>{skills.length}</strong>
        </div>
        {skills.length ? (
          <div className="card-list compact">
            {skills.slice(0, 3).map((skill) => (
              <button className="card-row" type="button" key={skill} onClick={() => onOpenInspector("trace")}>
                <span className="card-row-title">{skill}</span>
                <span>Observed in activity</span>
              </button>
            ))}
          </div>
        ) : (
          <button className="card-body-action muted" type="button" onClick={() => onOpenInspector("trace")}>
            <span>No skill usage detected</span>
            <small>Requires activity evidence</small>
          </button>
        )}
      </section>
    </div>
  )
}

function referencedFileSummaries(messages: ChatMessage[], composerReferences: FileReference[], files: UiFileSummary[]) {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const paths = new Set<string>()
  for (const reference of composerReferences) paths.add(reference.path)
  for (const message of messages) {
    for (const path of pathsFromMessage(message.text)) paths.add(path)
  }
  return [...paths].map((path) => byPath.get(path) ?? fileSummaryFromPath(path))
}

function pathsFromMessage(text: string) {
  const lines = text.split(/\r?\n/)
  const paths: string[] = []
  let inFileBlock = false
  for (const line of lines) {
    if (/^(Referenced files|Uploaded files):/i.test(line.trim())) {
      inFileBlock = true
      continue
    }
    if (!inFileBlock) continue
    if (!line.trim()) {
      inFileBlock = false
      continue
    }
    const match = line.match(/^\s*-\s+(.+?)(?:\s+\([^)]+\))?\s*$/)
    if (match?.[1]) paths.push(match[1])
  }
  return paths
}

function fileSummaryFromPath(path: string): UiFileSummary {
  return {
    path,
    size: 0,
    updatedAt: "",
    kind: /\.(txt|md|markdown|json|jsonc|csv|ts|tsx|js|jsx|py|html|css|log|yaml|yml|xml)$/i.test(path) ? "text" : "binary",
  }
}

function summarizeTools(trace: TraceItem[], activity: ActivityItem[]) {
  if (activity.length) {
    const visibleActivity = activity.filter(isPrimaryActivity)
    const toolItems = visibleActivity.filter((item) => item.toolName || item.kind === "tool" || item.kind === "shell" || item.kind === "file" || item.kind === "search")
    const names = [...new Set(toolItems.map((item) => item.toolName ?? item.kind).filter(Boolean))].slice(0, 3)
    return {
      total: toolItems.length,
      failed: visibleActivity.filter((item) => item.status === "error").length,
      names: names.length ? names : ["activity"],
    }
  }
  const calls = trace.filter((item) => item.kind === "call" || item.title.startsWith("tool "))
  const names = [...new Set(calls.map((item) => item.title.replace(/^tool\s+/, "").trim()).filter(Boolean))].slice(0, 3)
  return {
    total: calls.length,
    failed: trace.filter((item) => item.failed).length,
    names: names.length ? names : ["tool activity"],
  }
}

function skillNames(trace: TraceItem[], activity: ActivityItem[]) {
  const names = new Set<string>()
  for (const item of activity) {
    if (item.kind === "skill" && item.target) names.add(item.target.split("/")[0] ?? item.target)
    if (item.toolName?.includes("skill") && item.target) names.add(item.target.split("/")[0] ?? item.target)
  }
  for (const item of trace) {
    const value = `${item.title}\n${item.detail ?? ""}`
    const skillMatch = value.match(/\bskill(?:s|_name|Name)?["':\s]+([a-z0-9_.-]+)/i)
    if (skillMatch?.[1]) names.add(skillMatch[1])
    const skillPathMatch = value.match(/\.agents\/skills\/([^/\s"]+)/)
    if (skillPathMatch?.[1]) names.add(skillPathMatch[1])
  }
  return [...names]
}

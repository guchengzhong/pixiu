import { Activity, Files, GitCompareArrows, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent } from "react"

import type { SessionEvidence } from "../../../session/evidence"
import type { SessionTurn } from "../../../session/types"
import type { TodoItem } from "../../../todo/types"
import type { UiFileSummary, UiValidationRecord } from "../../shared/api"
import type { ActivityItem, FilePreview, FileReferenceRange, FileReferenceSource, InspectorTab, StatusSummary, TraceItem } from "../types"
import { ExecutionTimeline } from "./ExecutionTimeline"
import { SemanticActivityList } from "./SemanticActivityList"
import { TodoProgress } from "./TodoProgress"
import { WORKBENCH_INSPECTOR_ID, WORKBENCH_INSPECTOR_TRIGGER_ID } from "./WorkbenchLayout"
import { WorkspaceFiles } from "./WorkspaceFiles"

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

export function ActivityPanel(props: {
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
  const isMobileDrawer = useMobileDrawer()
  const panelRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const tabs = [
    { id: "activity" as const, label: "Activity", icon: Activity },
    { id: "changes" as const, label: "Changes", icon: GitCompareArrows },
    { id: "files" as const, label: "Files", icon: Files },
  ]

  useEffect(() => {
    if (!isMobileDrawer || !props.open) return
    const activeElement = document.activeElement
    const restoreFocus = activeElement instanceof HTMLElement && !panelRef.current?.contains(activeElement)
      ? activeElement
      : document.getElementById(WORKBENCH_INSPECTOR_TRIGGER_ID)
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())

    return () => {
      window.cancelAnimationFrame(frame)
      if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus()
    }
  }, [isMobileDrawer, props.open])

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!isMobileDrawer || !props.open) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.close()
      return
    }
    if (event.key !== "Tab" || !panelRef.current) return
    const focusable = focusableElements(panelRef.current)
    if (!focusable.length) {
      event.preventDefault()
      panelRef.current.focus()
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

  function startResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const panel = event.currentTarget.parentElement
    if (!panel) return
    const startX = event.clientX
    const startWidth = panel.getBoundingClientRect().width
    const move = (moveEvent: globalThis.PointerEvent) => props.onResize(startWidth + startX - moveEvent.clientX)
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      document.body.classList.remove("resizing-inspector")
    }
    document.body.classList.add("resizing-inspector")
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop, { once: true })
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const width = event.currentTarget.parentElement?.getBoundingClientRect().width
    if (!width) return
    props.onResize(width + (event.key === "ArrowLeft" ? 16 : -16))
  }

  function selectTabWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return
    event.preventDefault()
    const nextIndex = key === "Home"
      ? 0
      : key === "End"
        ? tabs.length - 1
        : (index + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    const next = tabs[nextIndex]
    if (!next) return
    props.setActiveTab(next.id)
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .item(nextIndex)
      .focus()
  }

  return (
    <aside
      className={`workspace-panel workbench-inspector ${props.open ? "open" : ""} ${props.collapsed ? "inspector-collapsed-panel" : ""}`}
      id={WORKBENCH_INSPECTOR_ID}
      ref={panelRef}
      role={isMobileDrawer ? "dialog" : undefined}
      aria-label="Inspector"
      aria-modal={isMobileDrawer && props.open ? true : undefined}
      aria-hidden={!props.open}
      inert={!props.open ? true : undefined}
      tabIndex={isMobileDrawer ? -1 : undefined}
      onKeyDown={handleDrawerKeyDown}
    >
      <div
        className="inspector-resize-handle"
        role="separator"
        aria-label="Resize inspector"
        aria-orientation="vertical"
        aria-valuemin={300}
        aria-valuemax={620}
        aria-valuenow={props.inspectorWidth}
        tabIndex={0}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
      />
      <div className="inspect-head">
        <strong>Inspector</strong>
        <button ref={closeButtonRef} className="icon-button inspector-toggle inspector-close" type="button" aria-label="Close inspector" title="Close inspector" onClick={props.close}><X aria-hidden="true" /></button>
      </div>
      <div className="tabs" role="tablist" aria-label="Inspector views">
        {tabs.map((tab, index) => {
          const Icon = tab.icon
          return <button
            className={`tab ${props.activeTab === tab.id ? "active" : ""}`}
            id={`inspector-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-controls="inspector-panel"
            aria-selected={props.activeTab === tab.id}
            tabIndex={props.activeTab === tab.id ? 0 : -1}
            key={tab.id}
            onClick={() => props.setActiveTab(tab.id)}
            onKeyDown={(event) => selectTabWithKeyboard(event, index)}
          >
            <Icon aria-hidden="true" />
            <span>{tab.label}</span>
          </button>
        })}
      </div>
      <div
        className="panel-body"
        id="inspector-panel"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${props.activeTab}`}
      >
        {props.activeTab === "activity" ? (
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
        {props.activeTab === "changes" || props.activeTab === "files" ? (
          <WorkspaceFiles
            view={props.activeTab}
            sessionId={props.sessionId}
            projectId={props.currentProjectId}
            files={props.files}
            preview={props.preview}
            evidence={props.evidence}
            turns={props.turns}
            validations={props.validations}
            onPreview={props.onPreview}
            onReference={props.onReference}
            onValidationsChange={props.onValidationsChange}
            onFixValidation={props.onFixValidation}
          />
        ) : null}
      </div>
    </aside>
  )
}

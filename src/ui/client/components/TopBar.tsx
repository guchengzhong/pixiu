import { Menu, PanelRight, Sparkles } from "lucide-react"

import type { RunStatus } from "../../../run/status"
import { pathBasename } from "../helpers"
import {
  WORKBENCH_INSPECTOR_ID,
  WORKBENCH_INSPECTOR_TRIGGER_ID,
  WORKBENCH_NAVIGATION_ID,
  WORKBENCH_NAVIGATION_TRIGGER_ID,
} from "./WorkbenchLayout"

export function TopBar({
  chatTitle,
  cwd,
  model,
  models,
  modelChanging,
  runStatus,
  runStatusLabel,
  navigationOpen,
  inspectorOpen,
  onOpenNavigation,
  onModelChange,
  onToggleInspector,
}: {
  chatTitle: string
  cwd: string | undefined
  model: string | undefined
  models: string[]
  modelChanging: boolean
  runStatus: RunStatus
  runStatusLabel: string
  navigationOpen: boolean
  inspectorOpen: boolean
  onOpenNavigation(): void
  onModelChange(model: string): void
  onToggleInspector(): void
}) {
  const projectName = pathBasename(cwd) || "Project"
  const choices = [...new Set([model, ...models].filter((value): value is string => Boolean(value)))]

  return (
    <header className="topbar workbench-topbar">
      <button
        className="icon-button mobile-nav-trigger"
        id={WORKBENCH_NAVIGATION_TRIGGER_ID}
        type="button"
        aria-label="Open navigation"
        aria-controls={WORKBENCH_NAVIGATION_ID}
        aria-expanded={navigationOpen}
        aria-haspopup="dialog"
        title="Open navigation"
        onClick={onOpenNavigation}
      >
        <Menu aria-hidden="true" />
      </button>
      <div className="topbar-context">
        <span className="project-name" title={cwd ?? projectName}>{projectName}</span>
        <span className="context-separator" aria-hidden="true">/</span>
        <strong className="conversation-title" title={chatTitle}>{chatTitle}</strong>
      </div>
      <div className="top-actions">
        <label className="model-picker">
          <Sparkles aria-hidden="true" />
          <span className="sr-only">Model</span>
          <select value={model ?? ""} disabled={modelChanging || !choices.length} aria-label="Model" onChange={(event) => onModelChange(event.currentTarget.value)}>
            {choices.map((choice) => <option value={choice} key={choice}>{choice}</option>)}
          </select>
        </label>
        <span className={`run-indicator run-status-${runStatus}`} aria-live="polite">
          <span aria-hidden="true" />
          {runStatusLabel}
        </span>
        <button
          className={`icon-button inspector-toggle ${inspectorOpen ? "active" : ""}`}
          id={WORKBENCH_INSPECTOR_TRIGGER_ID}
          type="button"
          aria-label={inspectorOpen ? "Close inspector" : "Open inspector"}
          aria-controls={WORKBENCH_INSPECTOR_ID}
          aria-expanded={inspectorOpen}
          title={inspectorOpen ? "Close inspector" : "Open inspector"}
          onClick={onToggleInspector}
        >
          <PanelRight aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}

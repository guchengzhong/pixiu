import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  FileText,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  GitBranch,
  Hammer,
  Link2,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
  Wrench,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { SessionEvidence } from "../../../session/evidence"
import type { SessionTurn } from "../../../session/types"
import type {
  UiFileSummary,
  UiChangeSetDiff,
  UiChangeSetFile,
  UiChangeSelection,
  UiChangeSetSnapshot,
  UiValidationKind,
  UiValidationRecord,
  UiWorkspaceChangedFile,
  UiWorkspaceChangeStatus,
  UiWorkspaceDiff,
  UiWorkspaceEntry,
  UiWorkspaceSnapshot,
} from "../../shared/api"
import { createUiApiClient, resolveUiToken, WORKSPACE_CHANGED_EVENT } from "../api"
import { errorMessage, fileNameFromPath, formatSize } from "../helpers"
import { redactUiText } from "../redact"
import type { FilePreview, FileReferenceRange, FileReferenceSource } from "../types"

type FileCategory = {
  key: FileReferenceSource
  title: string
  description: string
  empty: string
  files: UiFileSummary[]
}

type EvidenceItem = {
  title: string
  meta: string
  kind: "artifact" | "source" | "command"
}

type WorkspaceTreeNode = {
  entry: UiWorkspaceEntry
  children: WorkspaceTreeNode[]
}

type WorkspacePreviewState =
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; content: string }
  | { status: "error"; path: string; message: string }

type DisplayChange = Pick<UiWorkspaceChangedFile, "path" | "status" | "originalPath"> & {
  additions?: number
  deletions?: number
  binary?: boolean
  hunkCount?: number
  appliedHunkIds?: string[]
  applied?: boolean
  staged?: boolean
  committed?: boolean
}

export function WorkspaceFiles(props: {
  view?: "changes" | "files"
  sessionId?: string
  projectId?: string
  files: UiFileSummary[]
  preview: FilePreview | undefined
  evidence: SessionEvidence | undefined
  turns: SessionTurn[]
  validations: UiValidationRecord[]
  onPreview(file: UiFileSummary): void
  onReference(file: UiFileSummary, source: FileReferenceSource, range?: FileReferenceRange): void
  onValidationsChange(validations: UiValidationRecord[]): void
  onFixValidation(record: UiValidationRecord): void
}) {
  const token = typeof window === "undefined" ? "" : resolveUiToken(window.__PIXIU_UI_TOKEN__)
  const api = useMemo(() => createUiApiClient(token), [token])
  const [workspace, setWorkspace] = useState<UiWorkspaceSnapshot>()
  const [workspaceLoading, setWorkspaceLoading] = useState(true)
  const [workspaceError, setWorkspaceError] = useState<string>()
  const [changeSet, setChangeSet] = useState<UiChangeSetSnapshot>()
  const [changesError, setChangesError] = useState<string>()
  const [treeView, setTreeView] = useState<"files" | "changes">(props.view ?? "files")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string>()
  const [selectedView, setSelectedView] = useState<"preview" | "diff">("preview")
  const [workspacePreview, setWorkspacePreview] = useState<WorkspacePreviewState>()
  const [workspaceDiff, setWorkspaceDiff] = useState<UiWorkspaceDiff | UiChangeSetDiff>()
  const [rangeStart, setRangeStart] = useState("")
  const [rangeEnd, setRangeEnd] = useState("")
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [selectedHunks, setSelectedHunks] = useState<Map<string, Set<string>>>(new Map())
  const [changeBusy, setChangeBusy] = useState<string>()
  const [changeNotice, setChangeNotice] = useState<string>()
  const [commitMessage, setCommitMessage] = useState("")
  const [customValidation, setCustomValidation] = useState("")
  const [validationBusy, setValidationBusy] = useState<UiValidationKind>()
  const [validationError, setValidationError] = useState<string>()
  const requestGenerationRef = useRef(0)

  const loadWorkspace = useCallback(async () => {
    const generation = requestGenerationRef.current + 1
    requestGenerationRef.current = generation
    setWorkspaceLoading(true)
    setWorkspaceError(undefined)
    setChangesError(undefined)
    setWorkspace(undefined)
    try {
      const next = await api.workspace(props.projectId)
      if (requestGenerationRef.current !== generation) return
      setWorkspace(next)
      if (props.sessionId) {
        try {
          const changes = await api.sessionChanges(props.sessionId)
          if (requestGenerationRef.current === generation) setChangeSet(changes)
        } catch (error) {
          if (requestGenerationRef.current === generation) {
            setChangeSet(undefined)
            setChangesError(errorMessage(error))
          }
        }
      } else {
        setChangeSet(undefined)
      }
      setWorkspacePreview(undefined)
      setWorkspaceDiff(undefined)
    } catch (error) {
      if (requestGenerationRef.current !== generation) return
      setWorkspaceError(errorMessage(error))
    } finally {
      if (requestGenerationRef.current === generation) setWorkspaceLoading(false)
    }
  }, [api, props.projectId, props.sessionId])

  const visibleChanges: DisplayChange[] = props.sessionId
    ? (changeSet?.changes ?? []).map(changeSetDisplayChange)
    : workspace?.git.changedFiles ?? []

  useEffect(() => {
    setSelectedFiles(new Set())
    setSelectedHunks(new Map())
    setChangeNotice(undefined)
    setCommitMessage("")
    setCustomValidation("")
    setValidationError(undefined)
  }, [props.sessionId, changeSet?.revision])

  useEffect(() => {
    setTreeView(props.view ?? "files")
    if (!workspace) return
    if (props.view === "changes") {
      setSelectedPath((current) => visibleChanges.find((file) => file.path === current)?.path ?? visibleChanges[0]?.path)
      setSelectedView("diff")
      return
    }
    setSelectedPath((current) => workspace.entries.some((entry) => entry.path === current && entry.type === "file") ? current : undefined)
    setSelectedView("preview")
  }, [props.view, workspace, changeSet?.revision])

  useEffect(() => {
    void loadWorkspace()
    if (typeof window === "undefined") return
    window.addEventListener(WORKSPACE_CHANGED_EVENT, loadWorkspace)
    return () => {
      requestGenerationRef.current += 1
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, loadWorkspace)
    }
  }, [loadWorkspace])

  const tree = useMemo(() => workspaceTree(workspace?.entries ?? []), [workspace?.entries])
  const selectedEntry = workspace?.entries.find((entry) => entry.path === selectedPath) ?? sessionFileEntry(props.files, selectedPath)
  const selectedChange = visibleChanges.find((file) => file.path === selectedPath)
  const currentSelections = useMemo<UiChangeSelection[]>(() => [
    ...[...selectedFiles].sort().map((path) => ({ path })),
    ...[...selectedHunks.entries()]
      .filter(([, ids]) => ids.size > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, ids]) => ({ path, hunkIds: [...ids].sort() })),
  ], [selectedFiles, selectedHunks])
  const selectionPaths = useMemo(() => [...new Set(currentSelections.map((selection) => selection.path))], [currentSelections])
  const selectedChangeFiles = selectionPaths.map((path) => changeSet?.changes.find((file) => file.path === path)).filter(Boolean) as UiChangeSetFile[]
  const allChangesSelected = Boolean(changeSet?.changes.length) && changeSet.changes.every((file) => selectedFiles.has(file.path))
  const appliedSelections = currentSelections.flatMap((selection) => {
    const file = changeSet?.changes.find((candidate) => candidate.path === selection.path)
    if (!file) return []
    if (!selection.hunkIds) {
      const fullyApplied = file.applied && (file.hunkCount === 0 || file.appliedHunkIds.length >= file.hunkCount)
      return fullyApplied ? [] : [selection]
    }
    const applied = new Set(file.appliedHunkIds)
    const hunkIds = selection.hunkIds.filter((id) => !applied.has(id))
    return hunkIds.length ? [{ path: selection.path, hunkIds }] : []
  })
  const stageSelections = currentSelections.flatMap((selection) => {
    const file = changeSet?.changes.find((candidate) => candidate.path === selection.path)
    if (!file || file.committed) return []
    if (!selection.hunkIds) {
      const fullyApplied = file.applied && (file.hunkCount === 0 || file.appliedHunkIds.length >= file.hunkCount)
      return fullyApplied ? [selection] : []
    }
    const applied = new Set(file.appliedHunkIds)
    const hunkIds = selection.hunkIds.filter((id) => applied.has(id))
    return hunkIds.length ? [{ path: selection.path, hunkIds }] : []
  })
  const unstageSelections = currentSelections.filter((selection) => (
    changeSet?.changes.find((file) => file.path === selection.path)?.staged
  ))
  const stagedCount = changeSet?.changes.filter((file) => file.staged).length ?? 0
  const latestTurn = props.turns.at(-1)
  const turnValidations = latestTurn ? props.validations.filter((record) => record.turnId === latestTurn.id) : []

  useEffect(() => {
    if (!selectedPath || !workspace) return
    let active = true
    if (selectedView === "preview") {
      setWorkspaceDiff(undefined)
      if (!selectedEntry || selectedEntry.type !== "file") {
        setWorkspacePreview({ status: "error", path: selectedPath, message: "Preview is unavailable for this entry." })
        return
      }
      setWorkspacePreview({ status: "loading", path: selectedPath })
      const previewRequest = props.sessionId
        ? api.previewFile(props.sessionId, selectedPath)
        : api.previewWorkspaceFile(selectedPath, workspace.projectId)
      void previewRequest.then(
        (result) => {
          if (active) setWorkspacePreview({ status: "ready", path: result.path, content: result.content })
        },
        (error) => {
          if (active) setWorkspacePreview({ status: "error", path: selectedPath, message: errorMessage(error) })
        },
      )
    } else {
      setWorkspacePreview(undefined)
      setWorkspaceDiff(undefined)
      const request = props.sessionId && changeSet?.available
        ? api.sessionChangeDiff(props.sessionId, selectedPath)
        : api.diffWorkspaceFile(selectedPath, workspace.projectId)
      void request.then(
        (result) => {
          if (active) setWorkspaceDiff(result)
        },
        (error) => {
          if (active) {
            setWorkspaceDiff({
              path: selectedPath,
              available: false,
              content: "",
              truncated: false,
              reason: "command_failed",
              message: errorMessage(error),
            })
          }
        },
      )
    }
    return () => {
      active = false
    }
  }, [api, changeSet?.available, changeSet?.revision, props.sessionId, selectedEntry, selectedPath, selectedView, workspace])

  function toggleDirectory(path: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function selectWorkspaceFile(path: string, view: "preview" | "diff") {
    setSelectedPath(path)
    setSelectedView(view)
    setRangeStart("")
    setRangeEnd("")
  }

  function toggleFileSelection(path: string, checked: boolean) {
    setSelectedFiles((current) => {
      const next = new Set(current)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
    setSelectedHunks((current) => {
      if (!current.has(path)) return current
      const next = new Map(current)
      next.delete(path)
      return next
    })
    setChangeNotice(undefined)
  }

  function toggleHunkSelection(path: string, hunkId: string, checked: boolean) {
    setSelectedFiles((current) => {
      if (!current.has(path)) return current
      const next = new Set(current)
      next.delete(path)
      return next
    })
    setSelectedHunks((current) => {
      const next = new Map(current)
      const ids = new Set(next.get(path) ?? [])
      if (checked) ids.add(hunkId)
      else ids.delete(hunkId)
      if (ids.size) next.set(path, ids)
      else next.delete(path)
      return next
    })
    setChangeNotice(undefined)
  }

  function toggleAllChanges(checked: boolean) {
    setSelectedFiles(checked ? new Set(changeSet?.changes.map((file) => file.path) ?? []) : new Set())
    setSelectedHunks(new Map())
    setChangeNotice(undefined)
  }

  async function runChangeAction(action: "apply" | "discard" | "undo" | "stage" | "unstage") {
    if (!props.sessionId || !changeSet?.revision || changeBusy) return
    if (action === "discard" && !window.confirm(`Discard ${selectionPaths.length} selected file change${selectionPaths.length === 1 ? "" : "s"} from this session?`)) return
    setChangeBusy(action)
    setChangesError(undefined)
    setChangeNotice(undefined)
    try {
      const result = action === "apply"
        ? await api.applySessionChanges(props.sessionId, { revision: changeSet.revision, selections: appliedSelections })
        : action === "discard"
          ? await api.discardSessionChanges(props.sessionId, { revision: changeSet.revision, selections: currentSelections })
          : action === "undo"
            ? await api.undoSessionChanges(props.sessionId, { revision: changeSet.revision })
            : action === "stage"
              ? await api.stageSessionChanges(props.sessionId, { revision: changeSet.revision, selections: stageSelections })
              : await api.unstageSessionChanges(props.sessionId, { revision: changeSet.revision, selections: unstageSelections })
      setChangeSet(result.changes)
      setChangeNotice(changeOperationNotice(result.operation.action, result.operation.paths.length))
    } catch (error) {
      setChangesError(errorMessage(error))
    } finally {
      setChangeBusy(undefined)
    }
  }

  async function commitChanges() {
    if (!props.sessionId || !changeSet?.revision || !commitMessage.trim() || changeBusy) return
    setChangeBusy("commit")
    setChangesError(undefined)
    setChangeNotice(undefined)
    try {
      const result = await api.commitSessionChanges(props.sessionId, { revision: changeSet.revision, message: commitMessage.trim() })
      setChangeSet(result.changes)
      setCommitMessage("")
      setChangeNotice(result.operation.commit ? `Committed ${result.operation.commit.slice(0, 8)}.` : "Committed staged session changes.")
    } catch (error) {
      setChangesError(errorMessage(error))
    } finally {
      setChangeBusy(undefined)
    }
  }

  async function runValidation(kind: UiValidationKind) {
    if (!props.sessionId || !latestTurn || validationBusy) return
    const command = kind === "custom" ? customValidation.trim() : undefined
    if (kind === "custom" && !command) return
    if (kind === "custom" && !window.confirm(`Run this command in the isolated session workspace?\n\n${command}`)) return
    setValidationBusy(kind)
    setValidationError(undefined)
    try {
      const result = await api.runSessionValidation(props.sessionId, {
        turnId: latestTurn.id,
        kind,
        ...(command ? { command, confirmed: true } : {}),
      })
      props.onValidationsChange(result.validations)
      if (kind === "custom") setCustomValidation("")
      setChangeNotice(`${validationKindLabel(kind)} ${result.record.status}.`)
    } catch (error) {
      setValidationError(errorMessage(error))
    } finally {
      setValidationBusy(undefined)
    }
  }

  function referenceSelectedFile(range: FileReferenceRange = {}) {
    if (!selectedEntry || selectedEntry.type !== "file") return
    props.onReference({
      path: selectedEntry.path,
      size: selectedEntry.size ?? 0,
      updatedAt: selectedEntry.updatedAt ?? "",
      kind: selectedEntry.kind ?? "text",
    }, "workspace", range)
  }

  const parsedStart = positiveLine(rangeStart)
  const parsedEnd = positiveLine(rangeEnd)
  const rangeReady = parsedStart !== undefined && parsedEnd !== undefined && parsedEnd >= parsedStart

  return (
    <div className="tab-panel active workspace-files-view">
      <section className="workspace-browser" aria-label="Project workspace files">
        <header className="workspace-browser-header">
          <div className="workspace-browser-identity">
            <strong>{workspace?.projectName ?? "Project files"}</strong>
            <span className="workspace-root-path" title={workspace?.rootPath}>{workspace?.rootPath ?? "Current project root"}</span>
          </div>
          <div className="workspace-browser-meta">
            {workspace?.git.branch ? (
              <span className="workspace-branch" title="Git branch"><GitBranch aria-hidden="true" />{workspace.git.branch}</span>
            ) : null}
            <button className="icon-button workspace-refresh" type="button" title="Refresh workspace" aria-label="Refresh workspace" onClick={() => void loadWorkspace()}>
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="workspace-view-tabs" role="tablist" aria-label="Workspace views">
          <button className={treeView === "files" ? "active" : ""} type="button" role="tab" aria-selected={treeView === "files"} onClick={() => setTreeView("files")}>Files</button>
          <button className={treeView === "changes" ? "active" : ""} type="button" role="tab" aria-selected={treeView === "changes"} onClick={() => setTreeView("changes")}>
            Changes <span className="workspace-change-count">{visibleChanges.length}</span>
          </button>
        </div>

        {treeView === "changes" && props.sessionId && changeSet?.available && changeSet.revision ? (
          <div className="changes-command-bar">
            <div className="changes-selection-row">
              <label className="changes-select-all">
                <input type="checkbox" checked={allChangesSelected} onChange={(event) => toggleAllChanges(event.currentTarget.checked)} />
                <span>{currentSelections.length ? `${selectionPaths.length} selected` : "Select all"}</span>
              </label>
              <span className="changes-revision" title={changeSet.revision}>rev {changeSet.revision.slice(0, 8)}</span>
            </div>
            <div className="changes-actions" aria-label="Change actions">
              <button type="button" disabled={!appliedSelections.length || Boolean(changeBusy)} onClick={() => void runChangeAction("apply")}><Check aria-hidden="true" />Apply</button>
              <button type="button" disabled={!currentSelections.length || Boolean(changeBusy)} onClick={() => void runChangeAction("discard")}><Trash2 aria-hidden="true" />Discard</button>
              <button type="button" disabled={!changeSet.canUndo || Boolean(changeBusy)} onClick={() => void runChangeAction("undo")}><Undo2 aria-hidden="true" />Undo apply</button>
              <button type="button" disabled={!stageSelections.length || Boolean(changeBusy)} onClick={() => void runChangeAction("stage")}><GitBranch aria-hidden="true" />Stage selection</button>
              <button type="button" disabled={!unstageSelections.length || Boolean(changeBusy)} onClick={() => void runChangeAction("unstage")}><RotateCcw aria-hidden="true" />Unstage selection</button>
            </div>
            <form className="changes-commit-row" onSubmit={(event) => { event.preventDefault(); void commitChanges() }}>
              <input
                value={commitMessage}
                maxLength={4096}
                placeholder={stagedCount ? `Commit ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}` : "Stage changes before committing"}
                aria-label="Commit message"
                disabled={!stagedCount || Boolean(changeBusy)}
                onChange={(event) => setCommitMessage(event.currentTarget.value)}
              />
              <button type="submit" disabled={!stagedCount || !commitMessage.trim() || Boolean(changeBusy)}><GitCommitHorizontal aria-hidden="true" />Commit</button>
            </form>
            {changeBusy ? <div className="changes-operation-state" role="status">{changeActionProgress(changeBusy)}</div> : null}
            {changeNotice ? <div className="changes-operation-state changes-operation-success" role="status">{changeNotice}</div> : null}
          </div>
        ) : null}
        {treeView === "changes" && props.sessionId && changeSet?.available ? (
          <section className="changes-validation" aria-label="Validate session changes">
            <header className="changes-validation-header">
              <strong>Validate turn</strong>
              <span title={latestTurn?.id}>{latestTurn ? latestTurn.id.slice(0, 12) : "No assistant turn"}</span>
            </header>
            <div className="changes-validation-actions">
              <button type="button" disabled={!latestTurn || Boolean(validationBusy)} onClick={() => void runValidation("test")}><Play aria-hidden="true" />Run tests</button>
              <button type="button" disabled={!latestTurn || Boolean(validationBusy)} onClick={() => void runValidation("typecheck")}><ListChecks aria-hidden="true" />Typecheck</button>
              <button type="button" disabled={!latestTurn || Boolean(validationBusy)} onClick={() => void runValidation("build")}><Hammer aria-hidden="true" />Build</button>
            </div>
            <form className="changes-custom-validation" onSubmit={(event) => { event.preventDefault(); void runValidation("custom") }}>
              <input
                value={customValidation}
                maxLength={32768}
                placeholder="Custom validation command"
                aria-label="Custom validation command"
                disabled={!latestTurn || Boolean(validationBusy)}
                onChange={(event) => setCustomValidation(event.currentTarget.value)}
              />
              <button type="submit" disabled={!latestTurn || !customValidation.trim() || Boolean(validationBusy)}><Wrench aria-hidden="true" />Run</button>
            </form>
            {validationBusy ? <div className="changes-operation-state" role="status">Running {validationKindLabel(validationBusy).toLowerCase()}...</div> : null}
            {validationError ? <div className="changes-operation-state changes-operation-error" role="alert">{validationError}</div> : null}
            {turnValidations.length ? (
              <div className="validation-results">
                {turnValidations.map((record) => (
                  <details className={`validation-result validation-result-${record.status}`} key={record.id} open={record.status === "failed"}>
                    <summary>
                      <span className="validation-status-dot" aria-hidden="true" />
                      <strong>{validationKindLabel(record.kind)}</strong>
                      <span>{record.status}</span>
                      <small>{formatValidationDuration(record.durationMs)}</small>
                      {record.revision !== changeSet.revision ? <small className="validation-outdated">older revision</small> : null}
                    </summary>
                    <div className="validation-result-body">
                      <code>{record.command}</code>
                      {record.output ? <pre>{redactUiText(record.output)}</pre> : null}
                      {record.status === "failed" ? <button type="button" onClick={() => props.onFixValidation(record)}>Ask Pixiu to fix</button> : null}
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {workspaceLoading ? <div className="workspace-browser-state">Loading workspace...</div> : null}
        {workspaceError ? <div className="workspace-browser-state workspace-browser-error">{workspaceError}</div> : null}
        {treeView === "changes" && changesError ? <div className="workspace-browser-state workspace-browser-error">{changesError}</div> : null}
        {!workspaceLoading && workspace && !workspace.available ? (
          <div className="workspace-browser-state">{workspace.message ?? "Project workspace is unavailable."}</div>
        ) : null}
        {!workspaceLoading && workspace?.available && treeView === "files" ? (
          tree.length ? (
            <ul className="workspace-tree workspace-tree-root">
              {tree.map((node) => (
                <WorkspaceTreeItem
                  key={node.entry.path}
                  node={node}
                  expanded={expanded}
                  selectedPath={selectedPath}
                  onToggle={toggleDirectory}
                  onSelect={(path) => selectWorkspaceFile(path, "preview")}
                />
              ))}
            </ul>
          ) : <div className="workspace-browser-state">This project has no visible files.</div>
        ) : null}
        {!workspaceLoading && workspace?.available && treeView === "changes" ? (
          props.sessionId ? changeSet?.available ? (
            visibleChanges.length ? (
              <ul className="workspace-change-list">
                {visibleChanges.map((file) => (
                  <WorkspaceChangeItem
                    key={`${file.path}:${file.originalPath ?? ""}`}
                    file={file}
                    selected={selectedPath === file.path}
                    checked={selectedFiles.has(file.path)}
                    partial={Boolean(selectedHunks.get(file.path)?.size)}
                    onToggle={(checked) => toggleFileSelection(file.path, checked)}
                    onSelect={() => selectWorkspaceFile(file.path, "diff")}
                  />
                ))}
              </ul>
            ) : <div className="workspace-browser-state">This session has no changes.</div>
          ) : <div className="workspace-browser-state">{changeSet?.message ?? "Session changes are unavailable."}</div>
          : <div className="workspace-browser-state">Select or create a session to review its changes.</div>
        ) : null}
        {workspace?.truncated ? <div className="workspace-browser-notice">File tree limited to the first {workspace.entries.length} entries.</div> : null}
        {workspace?.git.truncated ? <div className="workspace-browser-notice">Git status output was truncated.</div> : null}
      </section>

      {selectedPath ? (
        <section className="workspace-file-detail" aria-label={`Selected file ${selectedPath}`}>
          <header className="workspace-file-detail-header">
            <div className="workspace-file-detail-title">
              <FileText aria-hidden="true" />
              <span title={selectedPath}>{selectedPath}</span>
              {selectedChange ? <WorkspaceStatus status={selectedChange.status} /> : null}
            </div>
            <div className="workspace-file-detail-actions">
              <button className="icon-button" type="button" title="Copy path" aria-label="Copy file path" onClick={() => void navigator.clipboard?.writeText(selectedPath)}><Copy aria-hidden="true" /></button>
              {selectedEntry?.type === "file" ? (
                <button className="workspace-add-prompt" type="button" title="Add the whole file to the prompt" onClick={() => referenceSelectedFile()}><Link2 aria-hidden="true" />Add to prompt</button>
              ) : null}
            </div>
          </header>
          <div className="workspace-file-view-tabs" role="tablist" aria-label="Selected file view">
            <button className={selectedView === "preview" ? "active" : ""} type="button" role="tab" aria-selected={selectedView === "preview"} onClick={() => setSelectedView("preview")}>Preview</button>
            <button className={selectedView === "diff" ? "active" : ""} type="button" role="tab" aria-selected={selectedView === "diff"} onClick={() => setSelectedView("diff")}>Diff</button>
          </div>
          {selectedEntry?.type === "file" && selectedEntry.kind !== "binary" ? (
            <div className="workspace-line-reference" aria-label="Add line range to prompt">
              <label>Start<input type="number" min="1" inputMode="numeric" value={rangeStart} onChange={(event) => setRangeStart(event.currentTarget.value)} /></label>
              <span aria-hidden="true">-</span>
              <label>End<input type="number" min="1" inputMode="numeric" value={rangeEnd} onChange={(event) => setRangeEnd(event.currentTarget.value)} /></label>
              <button type="button" disabled={!rangeReady} onClick={() => referenceSelectedFile({ startLine: parsedStart, endLine: parsedEnd })}><Link2 aria-hidden="true" />Add range</button>
            </div>
          ) : null}
          {selectedView === "preview" ? <WorkspacePreview state={workspacePreview} /> : (
            <WorkspaceDiffView
              diff={workspaceDiff}
              selectedHunkIds={selectedPath ? selectedHunks.get(selectedPath) ?? new Set() : new Set()}
              appliedHunkIds={new Set(selectedChange?.appliedHunkIds ?? [])}
              onToggleHunk={props.sessionId && selectedPath ? (hunkId, checked) => toggleHunkSelection(selectedPath, hunkId, checked) : undefined}
            />
          )}
        </section>
      ) : null}

      <SessionWorkspaceFiles {...props} />
    </div>
  )
}

function WorkspaceTreeItem(props: {
  node: WorkspaceTreeNode
  expanded: Set<string>
  selectedPath: string | undefined
  onToggle(path: string): void
  onSelect(path: string): void
}) {
  const { entry } = props.node
  const isDirectory = entry.type === "directory"
  const isExpanded = isDirectory && props.expanded.has(entry.path)
  return (
    <li className={`workspace-tree-node workspace-tree-${entry.type}`}>
      <button
        className={`workspace-tree-entry ${props.selectedPath === entry.path ? "selected" : ""}`}
        type="button"
        title={entry.path}
        {...(isDirectory ? { "aria-expanded": isExpanded } : {})}
        onClick={() => isDirectory ? props.onToggle(entry.path) : props.onSelect(entry.path)}
      >
        <span className="workspace-tree-chevron" aria-hidden="true">
          {isDirectory ? isExpanded ? <ChevronDown /> : <ChevronRight /> : null}
        </span>
        <span className="workspace-tree-icon" aria-hidden="true">
          {isDirectory ? isExpanded ? <FolderOpen /> : <Folder /> : entry.type === "file" ? <FileText /> : <File />}
        </span>
        <span className="workspace-tree-name">{entry.name}</span>
        {entry.gitStatus ? <WorkspaceStatus status={entry.gitStatus} compact /> : null}
      </button>
      {isDirectory && isExpanded && props.node.children.length ? (
        <ul className="workspace-tree workspace-tree-children">
          {props.node.children.map((child) => (
            <WorkspaceTreeItem key={child.entry.path} {...props} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function WorkspaceChangeItem(props: {
  file: DisplayChange
  selected: boolean
  checked: boolean
  partial: boolean
  onToggle(checked: boolean): void
  onSelect(): void
}) {
  return (
    <li className="workspace-change-row">
      <input
        className="workspace-change-checkbox"
        type="checkbox"
        checked={props.checked}
        aria-label={`Select ${props.file.path}`}
        aria-checked={props.partial ? "mixed" : props.checked}
        ref={(input) => {
          if (input) input.indeterminate = props.partial
        }}
        onChange={(event) => props.onToggle(event.currentTarget.checked)}
      />
      <button className={`workspace-change-entry ${props.selected ? "selected" : ""}`} type="button" title={props.file.path} onClick={props.onSelect}>
        <WorkspaceStatus status={props.file.status} compact />
        <span className="workspace-change-path">{props.file.path}</span>
        {props.file.additions !== undefined || props.file.deletions !== undefined ? (
          <span className="workspace-change-stats"><ins>+{props.file.additions ?? 0}</ins><del>-{props.file.deletions ?? 0}</del></span>
        ) : null}
        <span className="workspace-change-flags">
          {props.file.committed ? <span>Committed</span> : props.file.staged ? <span>Staged</span> : props.file.applied ? <span>Applied</span> : null}
        </span>
        {props.file.originalPath ? <span className="workspace-change-origin">from {props.file.originalPath}</span> : null}
      </button>
    </li>
  )
}

function changeSetDisplayChange(file: UiChangeSetFile): DisplayChange {
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    hunkCount: file.hunkCount,
    appliedHunkIds: file.appliedHunkIds,
    applied: file.applied,
    staged: file.staged,
    committed: file.committed,
  }
}

function sessionFileEntry(files: UiFileSummary[], path: string | undefined): UiWorkspaceEntry | undefined {
  if (!path) return undefined
  const file = files.find((item) => item.path === path)
  if (!file) return undefined
  const name = fileNameFromPath(file.path)
  const slash = file.path.lastIndexOf("/")
  return {
    path: file.path,
    name,
    parentPath: slash < 0 ? "." : file.path.slice(0, slash),
    type: "file",
    size: file.size,
    updatedAt: file.updatedAt,
    kind: file.kind,
  }
}

function WorkspaceStatus(props: { status: UiWorkspaceChangeStatus; compact?: boolean }) {
  return (
    <span className={`workspace-git-status workspace-status-${props.status}`} title={changeStatusLabel(props.status)}>
      {props.compact ? changeStatusCode(props.status) : changeStatusLabel(props.status)}
    </span>
  )
}

function WorkspacePreview(props: { state: WorkspacePreviewState | undefined }) {
  if (!props.state || props.state.status === "loading") return <div className="workspace-file-state">Loading preview...</div>
  if (props.state.status === "error") return <div className="workspace-file-state workspace-file-error">{props.state.message}</div>
  return <pre className="workspace-file-content"><code>{redactUiText(props.state.content)}</code></pre>
}

function WorkspaceDiffView(props: {
  diff: UiWorkspaceDiff | UiChangeSetDiff | undefined
  selectedHunkIds: Set<string>
  appliedHunkIds: Set<string>
  onToggleHunk?: (hunkId: string, checked: boolean) => void
}) {
  if (!props.diff) return <div className="workspace-file-state">Loading diff...</div>
  if (!props.diff.available) return <div className="workspace-file-state">{props.diff.message ?? "No diff is available for this file."}</div>
  if ("hunks" in props.diff && props.diff.hunks.length) {
    return (
      <div className="workspace-diff workspace-hunk-list">
        {props.diff.hunks.map((hunk) => (
          <section className={`workspace-diff-hunk ${props.appliedHunkIds.has(hunk.id) ? "applied" : ""}`} key={hunk.id}>
            <header className="workspace-diff-hunk-header">
              {props.onToggleHunk ? (
                <label>
                  <input
                    type="checkbox"
                    checked={props.selectedHunkIds.has(hunk.id)}
                    aria-label={`Select hunk ${hunk.header}`}
                    onChange={(event) => props.onToggleHunk?.(hunk.id, event.currentTarget.checked)}
                  />
                  <span>{hunk.header}</span>
                </label>
              ) : <span>{hunk.header}</span>}
              {props.appliedHunkIds.has(hunk.id) ? <span className="workspace-hunk-state"><Check aria-hidden="true" />Applied</span> : null}
            </header>
            <pre className="workspace-file-content workspace-diff-content"><code>{redactUiText(hunk.content)}</code></pre>
          </section>
        ))}
      </div>
    )
  }
  return (
    <div className="workspace-diff">
      {props.diff.truncated ? <div className="workspace-browser-notice">Diff limited to the first 1 MB.</div> : null}
      <pre className="workspace-file-content workspace-diff-content"><code>{redactUiText(props.diff.content)}</code></pre>
    </div>
  )
}

function SessionWorkspaceFiles(props: {
  files: UiFileSummary[]
  preview: FilePreview | undefined
  evidence: SessionEvidence | undefined
  onPreview(file: UiFileSummary): void
  onReference(file: UiFileSummary, source: FileReferenceSource, range?: FileReferenceRange): void
}) {
  const artifactPaths = new Set(props.evidence?.artifacts.map((item) => item.path) ?? [])
  const categories: FileCategory[] = [
    {
      key: "uploaded",
      title: "Uploaded",
      description: "Files added to this session through the composer.",
      empty: "No uploaded files in this session.",
      files: props.files.filter((file) => file.path.startsWith("uploads/")),
    },
    {
      key: "workspace",
      title: "Session workspace",
      description: "Files currently visible from the active session sandbox.",
      empty: "No session workspace files are visible yet.",
      files: props.files.filter((file) => !file.path.startsWith("uploads/") && !artifactPaths.has(file.path)),
    },
    {
      key: "generated",
      title: "Generated / Artifacts",
      description: "Files produced by agent write, edit, or patch activity.",
      empty: "No generated artifacts yet.",
      files: props.files.filter((file) => artifactPaths.has(file.path)),
    },
  ]
  const evidenceItems: EvidenceItem[] = [
    ...(props.evidence?.artifacts.map((item) => ({ title: item.path, meta: `artifact via ${item.tool}`, kind: "artifact" as const })) ?? []),
    ...(props.evidence?.sources.map((item) => ({ title: item.title ?? item.url ?? item.query ?? "source", meta: item.tool, kind: "source" as const })) ?? []),
    ...(props.evidence?.shellCommands.map((item) => ({
      title: item.command,
      meta: `command evidence${item.exitCode === undefined ? "" : ` · exit ${item.exitCode}`}`,
      kind: "command" as const,
    })) ?? []),
  ]

  return (
    <details className="session-files-disclosure">
      <summary>Session files and evidence <span className="file-count">{props.files.length + evidenceItems.length}</span></summary>
      <div className="session-files-content">
        {categories.map((category) => (
          <section className="file-category" key={category.key}>
            <div className="file-category-head">
              <div className="file-category-copy">
                <div className="file-category-title">
                  <strong>{category.title}</strong>
                  <span className="file-count">{category.files.length}</span>
                </div>
                <p>{category.description}</p>
              </div>
            </div>
            {category.files.length ? (
              category.files.slice(0, 40).map((file) => (
                <div className="file-row" key={`${category.key}:${file.path}`}>
                  <button className="file-item" type="button" onClick={() => props.onPreview(file)}>
                    <span className="file-name">{fileNameFromPath(file.path)}</span>
                    <span className="file-path" title={file.path}>{file.path}</span>
                    <span className="file-badges">
                      <span className="file-badge">{category.title}</span>
                      <span className="file-badge">{file.kind}</span>
                      <span className="file-badge muted">{formatSize(file.size)}</span>
                    </span>
                  </button>
                  <div className="file-actions">
                    <button className="file-action primary-action" type="button" onClick={() => props.onPreview(file)}>Preview</button>
                    <button className="file-action" type="button" onClick={() => props.onReference(file, category.key)}>Reference</button>
                    <button className="file-action subtle-action" type="button" onClick={() => void navigator.clipboard?.writeText(file.path)}>Copy</button>
                  </div>
                </div>
              ))
            ) : <div className="file-empty-state">{category.empty}</div>}
          </section>
        ))}
        <section className="file-category">
          <div className="file-category-head">
            <div className="file-category-copy">
              <div className="file-category-title">
                <strong>Evidence</strong>
                <span className="file-count">{evidenceItems.length}</span>
              </div>
              <p>Artifacts, web sources, and shell command evidence collected from runs.</p>
            </div>
          </div>
          {evidenceItems.length ? (
            evidenceItems.slice(0, 20).map((item, index) => (
              <div className={`evidence-file-row evidence-${item.kind}`} key={`${item.title}_${index}`}>
                <span className="evidence-kind">{item.kind === "command" ? "Command evidence" : item.kind}</span>
                <span className="file-name">{item.title}</span>
                <span className="file-meta">{item.meta}</span>
              </div>
            ))
          ) : <div className="file-empty-state">No evidence files or sources yet.</div>}
        </section>
        {props.preview ? (
          <div className={`preview file-preview-card ${props.preview.status !== "ready" ? "preview-unsupported" : ""}`}>
            <div className="preview-head">
              <strong>{props.preview.status === "ready" ? "Preview" : "Preview unavailable"}</strong>
              <span title={props.preview.path}>{props.preview.path}</span>
            </div>
            {props.preview.status === "ready" ? <pre>{redactUiText(props.preview.content ?? "")}</pre> : <p>{props.preview.message ?? "Preview is not available for this file type yet."}</p>}
          </div>
        ) : null}
      </div>
    </details>
  )
}

function positiveLine(value: string) {
  if (!/^\d+$/.test(value)) return undefined
  const line = Number(value)
  return Number.isSafeInteger(line) && line > 0 ? line : undefined
}

function changeOperationNotice(action: string, count: number) {
  const files = `${count} file${count === 1 ? "" : "s"}`
  if (action === "apply") return `Applied ${files} to the project.`
  if (action === "discard") return `Discarded changes from ${files}.`
  if (action === "undo") return `Undid the last apply for ${files}.`
  if (action === "stage") return `Staged ${files}.`
  if (action === "unstage") return `Unstaged ${files}.`
  return "Change operation completed."
}

function changeActionProgress(action: string) {
  if (action === "apply") return "Applying selected changes..."
  if (action === "discard") return "Discarding selected changes..."
  if (action === "undo") return "Undoing the last apply..."
  if (action === "stage") return "Staging selected changes..."
  if (action === "unstage") return "Unstaging selected changes..."
  if (action === "commit") return "Committing staged changes..."
  return "Updating changes..."
}

function validationKindLabel(kind: UiValidationKind) {
  if (kind === "test") return "Tests"
  if (kind === "typecheck") return "Typecheck"
  if (kind === "build") return "Build"
  return "Custom validation"
}

function formatValidationDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`
}

function workspaceTree(entries: UiWorkspaceEntry[]) {
  const children = new Map<string, WorkspaceTreeNode[]>()
  for (const entry of entries) {
    const siblings = children.get(entry.parentPath) ?? []
    siblings.push({ entry, children: [] })
    children.set(entry.parentPath, siblings)
  }
  const attach = (nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] => nodes.map((node) => ({
    ...node,
    children: attach(children.get(node.entry.path) ?? []),
  }))
  return attach(children.get(".") ?? [])
}

function changeStatusCode(status: UiWorkspaceChangeStatus) {
  if (status === "untracked") return "?"
  if (status === "conflicted") return "!"
  if (status === "type-changed") return "T"
  return status[0]?.toUpperCase() ?? "M"
}

function changeStatusLabel(status: UiWorkspaceChangeStatus) {
  return status === "type-changed" ? "Type changed" : `${status[0]?.toUpperCase()}${status.slice(1)}`
}

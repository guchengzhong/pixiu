import type { RefObject } from "react"

import { isActiveRunStatus, type RunStatus } from "../../../run/status"
import { formatSize, maybeSend } from "../helpers"
import type { FileReference } from "../types"

export function Composer({
  prompt,
  setPrompt,
  sendPrompt,
  fileInputRef,
  uploadFiles,
  permissionMode,
  setPermissionMode,
  runStatus,
  runStatusLabel,
  runId,
  cancelRun,
  attachments,
  uploadError,
  onPreviewAttachment,
  onRemoveAttachment,
}: {
  prompt: string
  setPrompt(value: string): void
  sendPrompt(): Promise<void>
  fileInputRef: RefObject<HTMLInputElement | null>
  uploadFiles(fileList: FileList | null): Promise<void>
  permissionMode: string
  setPermissionMode(value: string): void
  runStatus: RunStatus
  runStatusLabel: string
  runId: string | undefined
  cancelRun(): Promise<void>
  attachments: FileReference[]
  uploadError: string | undefined
  onPreviewAttachment(reference: FileReference): void
  onRemoveAttachment(reference: FileReference): void
}) {
  const active = isActiveRunStatus(runStatus)
  const canSend = Boolean(prompt.trim() || attachments.length) && !active

  return (
    <div className="composer-shell">
      <div className="composer">
        {attachments.length ? (
          <div className="composer-attachments" aria-label="Referenced files">
            {attachments.map((attachment) => (
              <span
                className="attachment-chip file-reference-chip"
                key={`${attachment.source}:${attachment.path}`}
              >
                <button className="attachment-preview" type="button" title={`Preview ${attachment.path}`} onClick={() => onPreviewAttachment(attachment)}>
                  <span className="attachment-name">{attachment.name}</span>
                  <span className="attachment-meta">
                    {attachment.source} · {attachment.size !== undefined ? formatSize(attachment.size) : attachment.kind ?? "file"} · {attachment.status}
                  </span>
                </button>
                <button
                  className="attachment-remove"
                  type="button"
                  title="Remove reference from this message"
                  onClick={() => onRemoveAttachment(attachment)}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={(event) => void maybeSend(event, sendPrompt)}
          placeholder="Message Pixiu"
          rows={2}
        />
        {uploadError ? <div className="upload-error">{uploadError}</div> : null}
        <div className="composer-row">
          <div className="composer-tools">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const input = event.currentTarget
                void uploadFiles(input.files).finally(() => {
                  input.value = ""
                })
              }}
            />
            <button className="icon-button" type="button" title="Upload files" onClick={() => fileInputRef.current?.click()}>+</button>
            <select className="select" value={permissionMode} onChange={(event) => setPermissionMode(event.currentTarget.value)} title="Permission mode">
              <option value="acceptEdits">accept edits</option>
              <option value="default">default</option>
              <option value="plan">plan</option>
              <option value="bypassPermissions">bypass</option>
            </select>
            {permissionMode === "bypassPermissions" ? <span className="warning">bypass enabled</span> : null}
            <span className={`run-status run-status-${runStatus}`}>{runStatusLabel}</span>
          </div>
          {runId && active ? <button className="ghost" type="button" onClick={() => void cancelRun()}>Cancel</button> : null}
          <button className="send" type="button" title={active ? runStatusLabel : "Send"} disabled={!canSend} onClick={() => void sendPrompt()}>↑</button>
        </div>
      </div>
    </div>
  )
}

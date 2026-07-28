import { ArrowUp, Paperclip, ShieldCheck, Square, X } from "lucide-react"
import { useEffect, useRef, type RefObject } from "react"

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
  const awaitingResult = Boolean(runId)
  const canSend = Boolean(prompt.trim() || attachments.length) && !active && !awaitingResult
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`
  }, [prompt])

  return (
    <div className="composer-shell">
      <div className="composer">
        {attachments.length ? (
          <div className="composer-attachments" aria-label="Referenced files">
            {attachments.map((attachment) => (
              <span
                className="attachment-chip file-reference-chip"
                key={`${attachment.source}:${attachment.path}:${attachment.startLine ?? ""}:${attachment.endLine ?? ""}`}
              >
                <button className="attachment-preview" type="button" title={`Preview ${fileReferenceLabel(attachment)}`} onClick={() => onPreviewAttachment(attachment)}>
                  <span className="attachment-name">{fileReferenceLabel(attachment)}</span>
                  <span className="attachment-meta">
                    {attachment.source} · {attachment.size !== undefined ? formatSize(attachment.size) : attachment.kind ?? "file"} · {attachment.status}
                  </span>
                </button>
                <button
                  className="attachment-remove"
                  type="button"
                  title="Remove reference from this message"
                  aria-label={`Remove ${attachment.name} from this message`}
                  onClick={() => onRemoveAttachment(attachment)}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={(event) => void maybeSend(event, sendPrompt)}
          placeholder="Message Pixiu"
          aria-label="Message Pixiu"
          rows={1}
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
            <button className="icon-button" type="button" aria-label="Attach files" title="Attach files" onClick={() => fileInputRef.current?.click()}><Paperclip aria-hidden="true" /></button>
            <label className="permission-select" title="Permission mode">
              <ShieldCheck aria-hidden="true" />
              <span className="sr-only">Permission mode</span>
              <select className="select" value={permissionMode} onChange={(event) => setPermissionMode(event.currentTarget.value)} aria-label="Permission mode">
                <option value="acceptEdits">Accept edits</option>
                <option value="default">Ask</option>
                <option value="plan">Plan</option>
                <option value="bypassPermissions">Bypass</option>
              </select>
            </label>
            {permissionMode === "bypassPermissions" ? <span className="warning">bypass enabled</span> : null}
            <span className={`run-status run-status-${runStatus}`}>{runStatusLabel}</span>
          </div>
          {runId && active ? <button className="stop-run" type="button" aria-label="Stop run" title="Stop run" onClick={() => void cancelRun()}><Square aria-hidden="true" /></button> : null}
          <button className="send" type="button" aria-label={active || awaitingResult ? runStatusLabel : "Send message"} title={active || awaitingResult ? runStatusLabel : "Send message"} disabled={!canSend} onClick={() => void sendPrompt()}><ArrowUp aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  )
}

function fileReferenceLabel(reference: FileReference) {
  const range = reference.startLine === undefined ? "" : `:${reference.startLine}-${reference.endLine ?? reference.startLine}`
  return `@${reference.path}${range}`
}

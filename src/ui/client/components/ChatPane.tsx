import { CheckCircle2, ChevronDown, CircleAlert, Clock3, FileOutput, History, Link2, Pencil, RefreshCw, Repeat2, Wrench } from "lucide-react"
import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react"

import type { RunStatus } from "../../../run/status"
import type { UiFileSummary, UiValidationRecord } from "../../shared/api"
import { SUGGESTIONS } from "../constants"
import { isNearScrollEnd } from "../helpers"
import { redactUiText } from "../redact"
import type { ChatMessage, FileReference } from "../types"
import { Composer } from "./Composer"
import { MarkdownMessage } from "./MarkdownMessage"

export function ChatPane({
  messages,
  setPrompt,
  prompt,
  sendPrompt,
  fileInputRef,
  uploadFiles,
  permissionMode,
  setPermissionMode,
  runStatus,
  runStatusLabel,
  runId,
  cancelRun,
  composerReferences,
  uploadError,
  removeComposerReference,
  previewReference,
  files,
  previewFile,
  editMessage,
  retryTurn,
  rollbackTurn,
  validations,
  fixValidation,
}: {
  messages: ChatMessage[]
  setPrompt(value: string): void
  prompt: string
  sendPrompt(): Promise<void>
  fileInputRef: RefObject<HTMLInputElement | null>
  uploadFiles(fileList: FileList | null): Promise<void>
  permissionMode: string
  setPermissionMode(value: string): void
  runStatus: RunStatus
  runStatusLabel: string
  runId: string | undefined
  cancelRun(): Promise<void>
  composerReferences: FileReference[]
  uploadError: string | undefined
  removeComposerReference(reference: FileReference): void
  previewReference(reference: FileReference): void
  files: UiFileSummary[]
  previewFile(file: UiFileSummary): void
  editMessage(message: ChatMessage): void
  retryTurn(turnId: string, anotherModel: boolean): Promise<void>
  rollbackTurn(turnId: string): Promise<void>
  validations: UiValidationRecord[]
  fixValidation(record: UiValidationRecord): void
}) {
  const [dragActive, setDragActive] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    if (!messages.length || !stickToBottomRef.current) return
    messageEndRef.current?.scrollIntoView({ block: "end" })
  }, [messages])

  function hasFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files")
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDragActive(true)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    setDragActive(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setDragActive(false)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDragActive(false)
    void uploadFiles(event.dataTransfer.files)
  }

  return (
    <div
      className={`chat-wrap workbench-chat ${dragActive ? "drop-active" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <div className="drop-overlay">
          <div>
            <strong>Drop files to upload</strong>
            <span>Files will be attached to this composer as references.</span>
          </div>
        </div>
      ) : null}
      <div
        className="messages"
        ref={messagesRef}
        onScroll={(event) => {
          const nearBottom = isNearScrollEnd(event.currentTarget)
          stickToBottomRef.current = nearBottom
          setShowJump(!nearBottom)
        }}
      >
        {!messages.length ? (
          <div className="empty">
            <h1>How can Pixiu help?</h1>
            <div className="suggestions">
              {SUGGESTIONS.map(([label, value]) => (
                <button className="suggestion" key={label} onClick={() => setPrompt(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="role">{message.role === "user" ? "You" : "Pixiu"}</div>
              {message.text ? (
                <div className={`bubble ${message.pending ? "pending" : ""}`}>
                  {message.role === "assistant"
                    ? <MarkdownMessage content={redactUiText(message.text)} />
                    : redactUiText(message.text)}
                </div>
              ) : message.pending ? <div className="assistant-thinking"><span /> Thinking</div> : null}
              {message.attachments?.length ? (
                <div className="turn-attachments" aria-label="Referenced files">
                  {message.attachments.map((attachment) => (
                    <button
                      type="button"
                      className="turn-attachment"
                      key={`${message.id}:${attachment.source}:${attachment.path}:${attachment.startLine ?? ""}:${attachment.endLine ?? ""}`}
                      title={fileReferenceLabel(attachment)}
                      onClick={() => previewFile(files.find((file) => file.path === attachment.path) ?? { path: attachment.path, size: attachment.size ?? 0, updatedAt: "", kind: attachment.kind ?? "text" })}
                    >
                      <FileOutput aria-hidden="true" />
                      <span>{fileReferenceLabel(attachment)}</span>
                      <small>{attachment.source}</small>
                    </button>
                  ))}
                </div>
              ) : null}
              {message.tools?.length || message.artifacts?.length ? (
                <div className="turn-output" aria-label="Turn activity and artifacts">
                  {message.tools?.map((tool) => (
                    <details className={`turn-tool turn-tool-${tool.status}`} key={`${message.id}:${tool.id}`}>
                      <summary>
                        <span className="turn-tool-icon" aria-hidden="true">
                          {tool.status === "running" ? <Clock3 /> : tool.status === "success" ? <CheckCircle2 /> : <CircleAlert />}
                        </span>
                        <Wrench aria-hidden="true" />
                        <span>{tool.name}</span>
                        <small>{tool.status}</small>
                        <ChevronDown className="turn-tool-chevron" aria-hidden="true" />
                      </summary>
                      {tool.detail ? <pre>{redactUiText(tool.detail)}</pre> : null}
                    </details>
                  ))}
                  {message.artifacts?.length ? (
                    <div className="turn-artifacts">
                      {message.artifacts.map((artifact) => artifact.url ? (
                        <a href={artifact.url} target="_blank" rel="noreferrer noopener" key={`${message.id}:${artifact.url}`}>
                          <Link2 aria-hidden="true" />
                          <span>{artifact.label}</span>
                        </a>
                      ) : (
                        <button
                          type="button"
                          key={`${message.id}:${artifact.path ?? artifact.label}`}
                          onClick={() => artifact.path && previewFile(files.find((file) => file.path === artifact.path) ?? { path: artifact.path, size: 0, updatedAt: "", kind: "text" })}
                        >
                          <FileOutput aria-hidden="true" />
                          <span>{artifact.label}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {message.role === "assistant" && message.turn ? (
                <div className={`turn-metrics turn-metrics-${message.turn.status}`} title={message.turn.error}>
                  <span>{message.turn.model}</span>
                  {message.turn.durationMs !== undefined ? <span>{formatDuration(message.turn.durationMs)}</span> : null}
                  {message.turn.inputTokens !== undefined ? <span>{message.turn.inputTokens.toLocaleString()} in</span> : null}
                  {message.turn.outputTokens !== undefined ? <span>{message.turn.outputTokens.toLocaleString()} out</span> : null}
                  {message.turn.retryCount > 0 ? <span>retry {message.turn.retryCount}</span> : null}
                  {message.turn.status === "error" ? <span className="turn-metric-error">failed</span> : null}
                </div>
              ) : null}
              {message.role === "assistant" && message.turn ? (
                <TurnValidations
                  records={validations.filter((record) => record.turnId === message.turn?.id)}
                  fixValidation={fixValidation}
                />
              ) : null}
              {!message.pending ? (
                <div className="turn-actions">
                  {message.role === "user" ? (
                    <button type="button" onClick={() => editMessage(message)}><Pencil aria-hidden="true" />Edit &amp; resend</button>
                  ) : message.turn ? (
                    <>
                      <button type="button" onClick={() => void retryTurn(message.turn!.id, false)}><RefreshCw aria-hidden="true" />Retry</button>
                      <button type="button" onClick={() => void retryTurn(message.turn!.id, true)}><Repeat2 aria-hidden="true" />Retry with another model</button>
                      {message.turn.checkpointId ? <button type="button" onClick={() => void rollbackTurn(message.turn!.id)}><History aria-hidden="true" />Restore files before turn</button> : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))
        )}
        <div ref={messageEndRef} />
      </div>
      {showJump ? (
        <button
          className="jump-latest"
          type="button"
          onClick={() => {
            stickToBottomRef.current = true
            setShowJump(false)
            messageEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
          }}
        >
          Jump to latest
        </button>
      ) : null}
      <Composer
        prompt={prompt}
        setPrompt={setPrompt}
        sendPrompt={sendPrompt}
        fileInputRef={fileInputRef}
        uploadFiles={uploadFiles}
        permissionMode={permissionMode}
        setPermissionMode={setPermissionMode}
        runStatus={runStatus}
        runStatusLabel={runStatusLabel}
        runId={runId}
        cancelRun={cancelRun}
        attachments={composerReferences}
        uploadError={uploadError}
        onPreviewAttachment={previewReference}
        onRemoveAttachment={removeComposerReference}
      />
    </div>
  )
}

function TurnValidations(props: { records: UiValidationRecord[]; fixValidation(record: UiValidationRecord): void }) {
  if (!props.records.length) return null
  return (
    <div className="turn-validations" aria-label="Turn validation results">
      {props.records.map((record) => (
        <details className={`turn-validation turn-validation-${record.status}`} key={record.id}>
          <summary>
            {record.status === "passed" ? <CheckCircle2 aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
            <strong>{validationLabel(record.kind)}</strong>
            <span>{record.status}</span>
            <small>{formatDuration(record.durationMs)}</small>
            <ChevronDown aria-hidden="true" />
          </summary>
          <div className="turn-validation-body">
            <code>{record.command}</code>
            {record.output ? <pre>{redactUiText(record.output)}</pre> : null}
            {record.status === "failed" ? <button type="button" onClick={() => props.fixValidation(record)}>Ask Pixiu to fix</button> : null}
          </div>
        </details>
      ))}
    </div>
  )
}

function fileReferenceLabel(reference: FileReference) {
  const range = reference.startLine === undefined ? "" : `:${reference.startLine}-${reference.endLine ?? reference.startLine}`
  return `@${reference.path}${range}`
}

function validationLabel(kind: UiValidationRecord["kind"]) {
  if (kind === "test") return "Tests"
  if (kind === "typecheck") return "Typecheck"
  if (kind === "build") return "Build"
  return "Custom validation"
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs} ms`
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.floor((durationMs % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

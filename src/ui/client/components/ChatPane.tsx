import { useState, type DragEvent, type RefObject } from "react"

import type { SessionEvidence } from "../../../session/evidence"
import type { TodoItem } from "../../../todo/types"
import type { UiFileSummary } from "../../shared/api"
import { SUGGESTIONS } from "../constants"
import { redactUiText } from "../redact"
import type { ChatMessage, FileReference, InspectorTab, TraceItem } from "../types"
import { Composer } from "./Composer"
import { StructuredCards } from "./StructuredCards"

export function ChatPane({
  messages,
  messageEndRef,
  setPrompt,
  prompt,
  sendPrompt,
  fileInputRef,
  uploadFiles,
  permissionMode,
  setPermissionMode,
  runStatus,
  runId,
  cancelRun,
  composerReferences,
  uploadError,
  removeComposerReference,
  previewReference,
  files,
  trace,
  evidence,
  todos,
  currentTodoId,
  openInspector,
  previewFile,
}: {
  messages: ChatMessage[]
  messageEndRef: RefObject<HTMLDivElement | null>
  setPrompt(value: string): void
  prompt: string
  sendPrompt(): Promise<void>
  fileInputRef: RefObject<HTMLInputElement | null>
  uploadFiles(fileList: FileList | null): Promise<void>
  permissionMode: string
  setPermissionMode(value: string): void
  runStatus: string
  runId: string | undefined
  cancelRun(): Promise<void>
  composerReferences: FileReference[]
  uploadError: string | undefined
  removeComposerReference(reference: FileReference): void
  previewReference(reference: FileReference): void
  files: UiFileSummary[]
  trace: TraceItem[]
  evidence: SessionEvidence | undefined
  todos: TodoItem[]
  currentTodoId: string | undefined
  openInspector(tab: InspectorTab): void
  previewFile(file: UiFileSummary): void
}) {
  const [dragActive, setDragActive] = useState(false)

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
      <div className="messages">
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
          messages.map((message, index) => (
            <div className={`message ${message.role}`} key={`${message.role}_${index}`}>
              <div className="role">{message.role === "user" ? "You" : "Pixiu"}</div>
              <div className={`bubble ${message.pending ? "pending" : ""}`}>{redactUiText(message.text)}</div>
            </div>
          ))
        )}
        <StructuredCards
          messages={messages}
          files={files}
          composerReferences={composerReferences}
          trace={trace}
          evidence={evidence}
          todos={todos}
          currentTodoId={currentTodoId}
          runStatus={runStatus}
          runId={runId}
          permissionMode={permissionMode}
          onOpenInspector={openInspector}
          onPreviewFile={previewFile}
        />
        <div ref={messageEndRef} />
      </div>
      <Composer
        prompt={prompt}
        setPrompt={setPrompt}
        sendPrompt={sendPrompt}
        fileInputRef={fileInputRef}
        uploadFiles={uploadFiles}
        permissionMode={permissionMode}
        setPermissionMode={setPermissionMode}
        runStatus={runStatus}
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

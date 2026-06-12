import React, { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import type { AgentEvent } from "../../agent/events"
import type { SessionEvidence } from "../../session/evidence"
import type { SessionMessage, MessagePart } from "../../session/types"
import type { UiFileSummary, UiProviderSummary, UiSessionSummary } from "../shared/api"
import { createUiApiClient, type ProviderConfigPayload } from "./api"
import { redactUiText } from "./redact"
import "./styles.css"

declare global {
  interface Window {
    __PIXIU_UI_TOKEN__?: string
  }
}

type TraceItem = {
  id: string
  title: string
  detail?: string
  kind?: string
  failed?: boolean
}

type PermissionView = {
  id: string
  request: {
    tool?: string
    input?: unknown
    risk?: string
    cwd?: string
  }
  decision: {
    reason?: string
  }
}

const ENDPOINTS = {
  siliconflow: "https://api.siliconflow.cn/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
}

const SUGGESTIONS = [
  ["Review this repository", "Review this repository and suggest the highest-impact next steps."],
  ["Create a plan first", "Create a careful plan before making any code changes."],
  ["Explain the project", "Inspect the current project and explain how it is structured."],
  ["Summarize uploaded files", "Use the uploaded files and summarize what matters."],
] as const

function App() {
  const token = window.__PIXIU_UI_TOKEN__
  const api = useMemo(() => createUiApiClient(token ?? ""), [token])
  const [provider, setProvider] = useState<UiProviderSummary>()
  const [sessions, setSessions] = useState<UiSessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string>()
  const [chatTitle, setChatTitle] = useState("New chat")
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string; pending?: boolean }>>([])
  const [prompt, setPrompt] = useState("")
  const [permissionMode, setPermissionMode] = useState("acceptEdits")
  const [runId, setRunId] = useState<string>()
  const [runStatus, setRunStatus] = useState("Ready")
  const [trace, setTrace] = useState<TraceItem[]>([])
  const [files, setFiles] = useState<UiFileSummary[]>([])
  const [preview, setPreview] = useState<{ path: string; content: string }>()
  const [evidence, setEvidence] = useState<SessionEvidence>()
  const [panelOpen, setPanelOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<"trace" | "files" | "evidence" | "status">("trace")
  const [configOpen, setConfigOpen] = useState(false)
  const [configNotice, setConfigNotice] = useState<{ text: string; kind?: "ok" | "error" }>({
    text: "Use env var mode to keep secrets out of pixiu.jsonc, or save a local key for quick setup. Responses redact secrets.",
  })
  const [providerForm, setProviderForm] = useState<ProviderConfigPayload>({
    baseURL: ENDPOINTS.siliconflow,
    model: "",
    credential: "apiKey",
    apiKeyEnv: "OPENAI_API_KEY",
  })
  const [endpointPreset, setEndpointPreset] = useState<keyof typeof ENDPOINTS | "custom">("siliconflow")
  const [permission, setPermission] = useState<PermissionView>()
  const [status, setStatus] = useState<{
    cwd?: string
    workspace?: string
    sessionsPath?: string
    skills?: number
    mcp?: { configured?: number; connected?: number; failed?: number; disabled?: number }
    providerKeyPresent?: boolean
  }>()
  const messageEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void refresh()
    void loadFiles()
  }, [])

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" })
  }, [messages])

  async function refresh() {
    const nextStatus = await api.status()
    setProvider(nextStatus.provider)
    setStatus({
      cwd: nextStatus.cwd,
      workspace: nextStatus.workspace.workspaceDir,
      sessionsPath: nextStatus.sessionsPath,
      skills: nextStatus.skills.diagnostics,
      mcp: nextStatus.mcp,
      providerKeyPresent: nextStatus.provider.keyPresent,
    })
    setProviderForm((current) => ({
      ...current,
      baseURL: nextStatus.provider.baseURL ?? "",
      model: nextStatus.provider.model ?? "",
      credential: nextStatus.provider.credential === "apiKeyEnv" ? "apiKeyEnv" : "apiKey",
      apiKeyEnv: nextStatus.provider.apiKeyEnv ?? "OPENAI_API_KEY",
      apiKey: "",
    }))
    setEndpointPreset(presetForBaseURL(nextStatus.provider.baseURL))
    if (!nextStatus.provider.keyPresent) {
      setConfigNotice({ text: "Add an API key to start chatting." })
      setConfigOpen(true)
    }
    await loadSessions()
  }

  async function loadSessions() {
    const data = await api.listSessions()
    setSessions(data.sessions.slice(0, 18))
  }

  async function loadSession(id: string) {
    const data = await api.getSession(id)
    setSessionId(data.session.id)
    setChatTitle(data.session.title ?? "Chat")
    setMessages(sessionMessages(data.messages))
    setTrace(traceFromMessages(data.messages))
    setEvidence(data.evidence)
    setFiles(data.files)
    setPreview(undefined)
    await loadSessions()
  }

  async function createSession(title = "New chat") {
    const data = await api.createSession({ title })
    setSessionId(data.session.id)
    setChatTitle(data.session.title ?? "New chat")
    setMessages([])
    setTrace([])
    setEvidence(undefined)
    setFiles(data.files)
    setPreview(undefined)
    await loadSessions()
    return data.session.id
  }

  async function ensureSession(title?: string) {
    if (sessionId) return sessionId
    return await createSession(title)
  }

  async function loadFiles(seed?: UiFileSummary[]) {
    if (seed) {
      setFiles(seed)
      return
    }
    if (!sessionId) return
    const data = await api.listFiles(sessionId)
    setFiles(data.files)
  }

  async function previewFile(path: string) {
    if (!sessionId) return
    const data = await api.previewFile(sessionId, path)
    setPreview({ path: data.path, content: data.content })
    setActiveTab("files")
    setPanelOpen(true)
  }

  async function uploadFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    const id = await ensureSession("Uploaded files")
    const data = await api.uploadFiles(id, fileList)
    setFiles(data.files)
    pushTrace({ title: "Uploaded files", detail: data.files.map((file) => file.path).join("\n") })
    setPrompt((current) => {
      const prefix = current.trim() ? `${current.trim()}\n` : ""
      return `${prefix}Uploaded files:\n${data.files.map((file) => `- ${file.path}`).join("\n")}`
    })
    setActiveTab("files")
    setPanelOpen(true)
  }

  async function saveProvider(closeAfter: boolean) {
    setConfigNotice({ text: "Saving..." })
    const baseURL = endpointPreset === "custom" ? providerForm.baseURL : ENDPOINTS[endpointPreset]
    const saved = await api.saveProvider({ ...providerForm, baseURL })
    setProvider(saved.provider)
    setProviderForm((current) => ({ ...current, apiKey: "" }))
    setConfigNotice({ text: "Provider saved.", kind: "ok" })
    await refresh()
    if (closeAfter) setConfigOpen(false)
  }

  async function testProvider() {
    try {
      await saveProvider(false)
      setConfigNotice({ text: "Testing provider..." })
      const result = await api.testProvider()
      setConfigNotice({ text: `Provider test passed: ${result.text || result.model || "ok"}`, kind: "ok" })
    } catch (error) {
      setConfigNotice({ text: errorMessage(error), kind: "error" })
    }
  }

  async function sendPrompt() {
    const message = prompt.trim()
    if (!message || runId) return
    if (provider && !provider.keyPresent) {
      setConfigNotice({ text: "Add an API key before sending." })
      setConfigOpen(true)
      return
    }
    setPrompt("")
    setMessages((current) => [...current, { role: "user", text: message }, { role: "assistant", text: "Thinking...", pending: true }])
    setRunStatus("Starting")
    try {
      const started = await api.startRun({ message, ...(sessionId ? { sessionId } : {}), permissionMode })
      setRunId(started.runId)
      await subscribeRun(started.runId)
    } catch (error) {
      replacePending(`Error: ${errorMessage(error)}`)
      pushTrace({ title: "Error", detail: errorMessage(error), failed: true })
      setPanelOpen(true)
    } finally {
      setRunId(undefined)
      setRunStatus("Ready")
    }
  }

  function subscribeRun(id: string) {
    return new Promise<void>((resolve, reject) => {
      const source = api.eventSource(id)
      source.addEventListener("run", (event) => {
        const data = JSON.parse(event.data) as { status?: string }
        setRunStatus(data.status ?? "Running")
      })
      source.addEventListener("agent_event", (event) => applyAgentEvent(JSON.parse(event.data) as AgentEvent))
      source.addEventListener("permission_request", (event) => {
        setPermission(JSON.parse(event.data) as PermissionView)
      })
      source.addEventListener("permission_result", (event) => {
        pushTrace({ title: "permission", detail: JSON.stringify(JSON.parse(event.data), null, 2), kind: "permission" })
      })
      source.addEventListener("result", (event) => {
        const result = JSON.parse(event.data) as { sessionId?: string; answer?: string; status: string; finishReason?: string }
        source.close()
        if (result.sessionId) {
          setSessionId(result.sessionId)
          void api.getSession(result.sessionId).then((detail) => {
            setChatTitle(detail.session.title ?? "Chat")
            setEvidence(detail.evidence)
            setFiles(detail.files)
          })
        }
        replacePending(result.answer || "(no answer)")
        pushTrace({
          title: "Run finished",
          detail: `status: ${result.status}\nfinishReason: ${result.finishReason ?? "unknown"}\nsessionId: ${result.sessionId ?? "new"}`,
        })
        void loadSessions()
        resolve()
      })
      source.onerror = () => {
        source.close()
        reject(new Error("Run event stream disconnected."))
      }
    })
  }

  function applyAgentEvent(event: AgentEvent) {
    if (event.type === "session_created") {
      setSessionId(event.sessionId)
      setChatTitle("Working chat")
      void loadSessions()
    }
    if (event.type === "llm_text_delta") appendAssistantDelta(event.text)
    if (event.type === "message") replacePending(event.content)
    if (event.type === "context_usage") setRunStatus(`${event.source} tokens ${event.inputTokens}`)
    if (event.type === "assistant_progress_delta") pushTrace({ title: "progress", detail: event.text, kind: "thinking" })
    if (event.type === "tool_call") {
      pushTrace({ title: `tool ${event.name}`, detail: JSON.stringify(event.input, null, 2), kind: "call" })
      setActiveTab("trace")
      setPanelOpen(true)
    }
    if (event.type === "tool_result") pushTrace({ title: `${event.ok ? "ok" : "failed"} ${event.name}`, detail: event.content, kind: "result", failed: !event.ok })
    if (event.type === "error") pushTrace({ title: "agent error", detail: event.message, failed: true })
    if (event.type === "finish") setSessionId(event.sessionId)
  }

  function appendAssistantDelta(text: string) {
    setMessages((current) => {
      const next = [...current]
      const last = next[next.length - 1]
      if (!last || last.role !== "assistant") return [...next, { role: "assistant", text }]
      next[next.length - 1] = { role: "assistant", text: last.pending ? text : `${last.text}${text}` }
      return next
    })
  }

  function replacePending(text: string) {
    setMessages((current) => {
      const next = [...current]
      const last = next[next.length - 1]
      if (!last || last.role !== "assistant") return [...next, { role: "assistant", text }]
      next[next.length - 1] = { role: "assistant", text }
      return next
    })
  }

  function pushTrace(item: Omit<TraceItem, "id">) {
    setTrace((current) => [{ id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, ...item }, ...current].slice(0, 80))
  }

  async function answerPermission(action: "allow" | "deny", scope: "once" | "sessionSimilar") {
    if (!permission) return
    const id = permission.id
    setPermission(undefined)
    await api.answerPermission(id, { action, scope })
  }

  async function cancelRun() {
    if (!runId) return
    await api.cancelRun(runId)
    setRunStatus("Cancelling")
  }

  const providerReady = provider?.keyPresent === true

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div className="brand-text">Pixiu</div>
        </div>
        <div className="sidebar-actions">
          <button className="side-button" onClick={() => void createSession("New chat")} title="New chat">
            <span className="side-icon">+</span>
            <span className="label">New chat</span>
          </button>
          <button className="side-button" onClick={() => setConfigOpen(true)} title="Configure API">
            <span className="side-icon">API</span>
            <span className="label">Configure API</span>
          </button>
        </div>
        <div className="side-section">
          <div className="side-title">Chats</div>
          {sessions.map((session) => (
            <button
              className={`session ${session.id === sessionId ? "active" : ""}`}
              key={session.id}
              title={session.title ?? session.id}
              onClick={() => void loadSession(session.id)}
            >
              <span className="session-name">{session.title ?? "Untitled chat"}</span>
              <span className="session-meta">{shortDate(session.updatedAt)}{session.workspaceDir ? ` · ${session.workspaceDir}` : ""}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="status-card">
            <div className="status-row">
              <span><span className={`dot ${providerReady ? "ok" : "warn"}`} />Provider</span>
              <span>{providerReady ? "ready" : "missing key"}</span>
            </div>
            <div className="status-row">
              <span>Workspace</span>
              <span>{status?.workspace ?? "loading"}</span>
            </div>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="conversation-title">
            <strong>{chatTitle}</strong>
            <span className="pill">{provider?.model ?? "model"}</span>
            <span className={`pill ${providerReady ? "ok" : "warn"}`}>{providerReady ? "API ready" : "API key missing"}</span>
          </div>
          <div className="top-actions">
            <button className="ghost" onClick={() => { setActiveTab("status"); setPanelOpen(true) }}>Status</button>
            <button className="ghost" onClick={() => setPanelOpen((open) => !open)}>Activity</button>
            <button className="ghost" onClick={() => setConfigOpen(true)}>API</button>
          </div>
        </header>
        <section className="content">
          <div className="chat-wrap">
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
              <div ref={messageEndRef} />
            </div>
            <div className="composer-shell">
              <div className="composer">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                  onKeyDown={(event) => void maybeSend(event, sendPrompt)}
                  placeholder="Message Pixiu"
                  rows={2}
                />
                <div className="composer-row">
                  <div className="composer-tools">
                    <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void uploadFiles(event.currentTarget.files)} />
                    <button className="icon-button" type="button" title="Upload files" onClick={() => fileInputRef.current?.click()}>+</button>
                    <select className="select" value={permissionMode} onChange={(event) => setPermissionMode(event.currentTarget.value)} title="Permission mode">
                      <option value="acceptEdits">accept edits</option>
                      <option value="default">default</option>
                      <option value="plan">plan</option>
                      <option value="bypassPermissions">bypass</option>
                    </select>
                    {permissionMode === "bypassPermissions" ? <span className="warning">bypass enabled</span> : null}
                    <span className="run-status">{runStatus}</span>
                  </div>
                  {runId ? <button className="ghost" type="button" onClick={() => void cancelRun()}>Cancel</button> : null}
                  <button className="send" type="button" title="Send" disabled={!prompt.trim() || Boolean(runId)} onClick={() => void sendPrompt()}>↑</button>
                </div>
              </div>
            </div>
          </div>
          <ActivityPanel
            open={panelOpen}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            close={() => setPanelOpen(false)}
            trace={trace}
            files={files}
            preview={preview}
            evidence={evidence}
            status={status}
            onPreview={(path) => void previewFile(path)}
          />
        </section>
      </main>
      <ConfigModal
        open={configOpen}
        close={() => setConfigOpen(false)}
        notice={configNotice}
        form={providerForm}
        setForm={setProviderForm}
        endpointPreset={endpointPreset}
        setEndpointPreset={setEndpointPreset}
        save={() => void saveProvider(true)}
        test={() => void testProvider()}
      />
      <PermissionModal permission={permission} answer={(action, scope) => void answerPermission(action, scope)} />
    </div>
  )
}

function ActivityPanel(props: {
  open: boolean
  activeTab: "trace" | "files" | "evidence" | "status"
  setActiveTab(tab: "trace" | "files" | "evidence" | "status"): void
  close(): void
  trace: TraceItem[]
  files: UiFileSummary[]
  preview?: { path: string; content: string }
  evidence?: SessionEvidence
  status?: { cwd?: string; workspace?: string; sessionsPath?: string; skills?: number; mcp?: { configured?: number; connected?: number; failed?: number; disabled?: number }; providerKeyPresent?: boolean }
  onPreview(path: string): void
}) {
  return (
    <aside className={`workspace-panel ${props.open ? "open" : ""}`}>
      <div className="inspect-head">
        <strong>Activity</strong>
        <button className="icon-button" type="button" title="Close" onClick={props.close}>x</button>
      </div>
      <div className="tabs">
        {(["trace", "files", "evidence", "status"] as const).map((tab) => (
          <button className={`tab ${props.activeTab === tab ? "active" : ""}`} type="button" key={tab} onClick={() => props.setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {props.activeTab === "trace" ? <TraceList trace={props.trace} /> : null}
        {props.activeTab === "files" ? <FileList files={props.files} preview={props.preview} onPreview={props.onPreview} /> : null}
        {props.activeTab === "evidence" ? <EvidenceView evidence={props.evidence} /> : null}
        {props.activeTab === "status" ? <StatusView status={props.status} /> : null}
      </div>
    </aside>
  )
}

function TraceList({ trace }: { trace: TraceItem[] }) {
  if (!trace.length) return <div className="empty-panel">Tool calls and run events appear here.</div>
  return (
    <div className="tab-panel active">
      {trace.map((item) => (
        <details className={`trace-item ${item.failed ? "failed" : ""}`} key={item.id} open={false}>
          <summary className="trace-title">
            <span>{item.title}</span>
            {item.kind ? <span className="trace-kind">{item.kind}</span> : null}
          </summary>
          {item.detail ? <pre>{redactUiText(item.detail)}</pre> : null}
        </details>
      ))}
    </div>
  )
}

function FileList(props: { files: UiFileSummary[]; preview?: { path: string; content: string }; onPreview(path: string): void }) {
  if (!props.files.length) return <div className="empty-panel">No files in this workspace yet.</div>
  return (
    <div className="tab-panel active">
      {props.files.slice(0, 40).map((file) => (
        <div className="file-row" key={file.path}>
          <button className="file-item" type="button" onClick={() => props.onPreview(file.path)}>
            <span className="file-name">{file.path}</span>
            <span className="file-meta">{file.kind} · {formatSize(file.size)}</span>
          </button>
          <button className="copy-button" type="button" onClick={() => void navigator.clipboard?.writeText(file.path)}>copy</button>
        </div>
      ))}
      {props.preview ? (
        <div className="preview">
          <strong>{props.preview.path}</strong>
          <pre>{redactUiText(props.preview.content)}</pre>
        </div>
      ) : null}
    </div>
  )
}

function EvidenceView({ evidence }: { evidence?: SessionEvidence }) {
  if (!evidence) return <div className="empty-panel">Evidence appears after a run uses tools.</div>
  const items = [
    ...evidence.artifacts.map((item) => ({ title: item.path, meta: `artifact via ${item.tool}` })),
    ...evidence.sources.map((item) => ({ title: item.title ?? item.url ?? item.query ?? "source", meta: `${item.tool}${item.accessedAt ? ` · ${shortDate(item.accessedAt)}` : ""}` })),
    ...evidence.shellCommands.map((item) => ({ title: item.command, meta: `shell${item.exitCode === undefined ? "" : ` · exit ${item.exitCode}`}` })),
  ]
  if (!items.length) return <div className="empty-panel">No artifacts, sources, or shell commands yet.</div>
  return (
    <div className="tab-panel active">
      {items.map((item, index) => (
        <div className="trace-item" key={`${item.title}_${index}`}>
          <div className="trace-title">{item.title}</div>
          <div className="file-meta">{item.meta}</div>
        </div>
      ))}
    </div>
  )
}

function StatusView({ status }: { status?: { cwd?: string; workspace?: string; sessionsPath?: string; skills?: number; mcp?: { configured?: number; connected?: number; failed?: number; disabled?: number }; providerKeyPresent?: boolean } }) {
  return (
    <div className="tab-panel active">
      <div className="trace-item"><strong>Provider key</strong><pre>{status?.providerKeyPresent ? "ready" : "missing"}</pre></div>
      <div className="trace-item"><strong>Project</strong><pre>{status?.cwd ?? "loading"}</pre></div>
      <div className="trace-item"><strong>Workspace</strong><pre>{status?.workspace ?? "loading"}</pre></div>
      <div className="trace-item"><strong>Session store</strong><pre>{status?.sessionsPath ?? "loading"}</pre></div>
      <div className="trace-item"><strong>Diagnostics</strong><pre>{`skills: ${status?.skills ?? 0}\nmcp configured: ${status?.mcp?.configured ?? 0}\nmcp connected: ${status?.mcp?.connected ?? 0}\nmcp failed: ${status?.mcp?.failed ?? 0}\nmcp disabled: ${status?.mcp?.disabled ?? 0}`}</pre></div>
    </div>
  )
}

function ConfigModal(props: {
  open: boolean
  close(): void
  notice: { text: string; kind?: "ok" | "error" }
  form: ProviderConfigPayload
  setForm(updater: (form: ProviderConfigPayload) => ProviderConfigPayload): void
  endpointPreset: keyof typeof ENDPOINTS | "custom"
  setEndpointPreset(value: keyof typeof ENDPOINTS | "custom"): void
  save(): void
  test(): void
}) {
  if (!props.open) return null
  const update = (patch: Partial<ProviderConfigPayload>) => props.setForm((current) => ({ ...current, ...patch }))
  return (
    <div className="config open">
      <div className="config-panel">
        <div className="config-head">
          <strong>Provider configuration</strong>
          <button className="ghost" type="button" onClick={props.close}>Close</button>
        </div>
        <form className="config-body" onSubmit={(event) => { event.preventDefault(); props.save() }}>
          <div className="config-grid">
            <div className="field">
              <label htmlFor="endpointPreset">Endpoint</label>
              <select
                id="endpointPreset"
                value={props.endpointPreset}
                onChange={(event) => {
                  const value = event.currentTarget.value as keyof typeof ENDPOINTS | "custom"
                  props.setEndpointPreset(value)
                  if (value !== "custom") update({ baseURL: ENDPOINTS[value] })
                }}
              >
                <option value="siliconflow">SiliconFlow</option>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="custom">Custom URL</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="model">Model</label>
              <input id="model" value={props.form.model} onChange={(event) => update({ model: event.currentTarget.value })} placeholder="provider/model" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="baseURL">Base URL</label>
            <input id="baseURL" value={props.form.baseURL} onChange={(event) => update({ baseURL: event.currentTarget.value })} placeholder="https://api.example.com/v1" />
          </div>
          <div className="config-grid">
            <div className="field">
              <label htmlFor="credential">Credential</label>
              <select id="credential" value={props.form.credential} onChange={(event) => update({ credential: event.currentTarget.value as "apiKey" | "apiKeyEnv" })}>
                <option value="apiKey">API key</option>
                <option value="apiKeyEnv">Environment variable</option>
              </select>
            </div>
            {props.form.credential === "apiKeyEnv" ? (
              <div className="field">
                <label htmlFor="apiKeyEnv">API key env var</label>
                <input id="apiKeyEnv" value={props.form.apiKeyEnv ?? ""} onChange={(event) => update({ apiKeyEnv: event.currentTarget.value })} placeholder="OPENAI_API_KEY" />
              </div>
            ) : null}
          </div>
          {props.form.credential === "apiKey" ? (
            <div className="field">
              <label htmlFor="apiKey">API key</label>
              <input id="apiKey" type="password" value={props.form.apiKey ?? ""} onChange={(event) => update({ apiKey: event.currentTarget.value })} placeholder="Leave blank to keep the existing key" />
            </div>
          ) : null}
          <div className={`notice ${props.notice.kind ?? ""}`}>{props.notice.text}</div>
          <div className="form-actions">
            <button className="ghost" type="button" onClick={props.test}>Save and test</button>
            <button className="primary" type="submit">Save provider</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function PermissionModal({ permission, answer }: { permission?: PermissionView; answer(action: "allow" | "deny", scope: "once" | "sessionSimilar"): void }) {
  if (!permission) return null
  return (
    <div className="config open">
      <div className="config-panel permission-panel">
        <div className="config-head">
          <strong>Permission required</strong>
          <span className="pill">{permission.request.risk ?? "risk"}</span>
        </div>
        <div className="config-body">
          <div className="notice">{permission.decision.reason ?? ""}</div>
          <div className="preview">
            <strong>{permission.request.tool ?? "tool"}</strong>
            <pre>{redactUiText(JSON.stringify(permission.request.input ?? {}, null, 2))}</pre>
          </div>
          <div className="form-actions">
            <button className="danger" type="button" onClick={() => answer("deny", "once")}>Deny</button>
            <button className="ghost" type="button" onClick={() => answer("allow", "sessionSimilar")}>Allow similar</button>
            <button className="primary" type="button" onClick={() => answer("allow", "once")}>Allow once</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function sessionMessages(messages: SessionMessage[]) {
  const result: Array<{ role: "user" | "assistant"; text: string }> = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue
    const text = textFromParts(message.parts)
    if (text) result.push({ role: message.role, text })
  }
  return result
}

function traceFromMessages(messages: SessionMessage[]): TraceItem[] {
  const items: TraceItem[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") items.push({ id: part.id, title: `tool ${part.name}`, detail: JSON.stringify(part.input, null, 2), kind: "call" })
      if (part.type === "tool_result") {
        const result = asToolResult(part)
        items.push({ id: part.toolCallId, title: `${result.ok === false ? "failed" : "ok"} ${part.name}`, detail: JSON.stringify(part.result, null, 2), kind: "result", failed: result.ok === false })
      }
      if (part.type === "error") items.push({ id: message.id, title: "agent error", detail: part.message, failed: true })
    }
  }
  return items.reverse()
}

function asToolResult(part: Extract<MessagePart, { type: "tool_result" }>) {
  return part.result && typeof part.result === "object" && !Array.isArray(part.result) ? (part.result as { ok?: boolean }) : {}
}

function textFromParts(parts: MessagePart[]) {
  return parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function maybeSend(event: KeyboardEvent<HTMLTextAreaElement>, send: () => Promise<void>) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    return send()
  }
  return undefined
}

function presetForBaseURL(value: string | undefined): keyof typeof ENDPOINTS | "custom" {
  const normalized = String(value ?? "").replace(/\/+$/, "")
  for (const [key, endpoint] of Object.entries(ENDPOINTS)) {
    if (endpoint === normalized) return key as keyof typeof ENDPOINTS
  }
  return "custom"
}

function shortDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<App />)

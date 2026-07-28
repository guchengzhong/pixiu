import { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import type { AgentEvent } from "../../agent/events"
import { limitActivityItems } from "../../activity/format"
import type { SessionEvidence } from "../../session/evidence"
import type { TodoItem } from "../../todo/types"
import type {
  ActivityUpdatedEvent,
  RunStatusEvent,
  UiFileSummary,
  UiMcpServerSummary,
  UiProjectSummary,
  UiProviderSummary,
  UiRunResult,
  UiSessionSummary,
  UiSkillSummary,
  UiValidationRecord,
} from "../shared/api"
import { isActiveRunStatus, isTerminalRunStatus, normalizePersistedRunStatus, normalizeRunStatus, runStatusLabel, type RunStatus } from "../../run/status"
import { createUiApiClient, resolveUiToken, WORKSPACE_CHANGED_EVENT, type ProviderConfigPayload } from "./api"
import { AppSidebar } from "./components/AppSidebar"
import { ChatPane } from "./components/ChatPane"
import { ConfigModal } from "./components/ConfigModal"
import { FolderPicker } from "./components/FolderPicker"
import { PermissionModal } from "./components/PermissionModal"
import { RightInspector } from "./components/RightInspector"
import { TopBar } from "./components/TopBar"
import { WorkbenchPanelView } from "./components/WorkbenchPanelView"
import { WorkbenchLayout } from "./components/WorkbenchLayout"
import { ENDPOINTS } from "./constants"
import {
  assistantTextFromRunResult,
  errorMessage,
  failureMessageFromAgentEvent,
  failureMessageFromRunErrorEvent,
  fileNameFromPath,
  isPreviewUnsupported,
  presetForBaseURL,
  sessionMessages,
  staleRunMessage,
  traceFromMessages,
} from "./helpers"
import { currentTodoIdFromTodos, normalizeTodos, todoUpdateMatchesSession } from "./todos"
import type { ActivityItem, ChatMessage, FilePreview, FileReference, FileReferenceRange, FileReferenceSource, InspectorTab, PermissionView, StatusSummary, TraceItem, WorkbenchPanel } from "./types"
import "./styles.css"

declare global {
  interface Window {
    __PIXIU_UI_TOKEN__?: string
  }
}

const MODEL_OPTIONS = ["deepseek-ai/DeepSeek-V3.2", "Pro/moonshotai/Kimi-K2.6"]

function nextMessageId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function App() {
  const token = resolveUiToken(window.__PIXIU_UI_TOKEN__)
  const api = useMemo(() => createUiApiClient(token ?? ""), [token])
  const [provider, setProvider] = useState<UiProviderSummary>()
  const [projects, setProjects] = useState<UiProjectSummary[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string>()
  const [sessions, setSessions] = useState<UiSessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState<string>()
  const [skills, setSkills] = useState<UiSkillSummary[]>([])
  const [mcpServers, setMcpServers] = useState<UiMcpServerSummary[]>([])
  const [workbenchPanel, setWorkbenchPanel] = useState<WorkbenchPanel>("chat")
  const [sessionId, setSessionId] = useState<string>()
  const [chatTitle, setChatTitle] = useState("New chat")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState("")
  const [permissionMode, setPermissionMode] = useState("acceptEdits")
  const [runId, setRunId] = useState<string>()
  const [runStatus, setRunStatus] = useState<RunStatus>("idle")
  const [trace, setTrace] = useState<TraceItem[]>([])
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [files, setFiles] = useState<UiFileSummary[]>([])
  const [preview, setPreview] = useState<FilePreview>()
  const [composerReferences, setComposerReferences] = useState<FileReference[]>([])
  const [uploadError, setUploadError] = useState<string>()
  const [evidence, setEvidence] = useState<SessionEvidence>()
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [validations, setValidations] = useState<UiValidationRecord[]>([])
  const [currentTodoId, setCurrentTodoId] = useState<string>()
  const [panelOpen, setPanelOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true)
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const stored = Number.parseInt(window.localStorage.getItem("pixiu.inspectorWidth") ?? "", 10)
    return Number.isFinite(stored) ? Math.min(620, Math.max(300, stored)) : 380
  })
  const [activeTab, setActiveTab] = useState<InspectorTab>("activity")
  const [configOpen, setConfigOpen] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
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
  const [status, setStatus] = useState<StatusSummary>()
  const [folderPicker, setFolderPicker] = useState<{ resolve(path?: string): void }>()
  const [modelChanging, setModelChanging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sessionIdRef = useRef<string | undefined>(undefined)
  const sessionSelectionGenerationRef = useRef(0)
  const runIdBySessionRef = useRef(new Map<string, string>())
  const runStatusBySessionRef = useRef(new Map<string, RunStatus>())
  const permissionBySessionRef = useRef(new Map<string, PermissionView>())
  const statusSummary = useMemo(
    () => ({
      ...(status ?? {}),
      runStatus,
      runStatusLabel: runStatusLabel(runStatus),
    }),
    [runStatus, status],
  )
  const turns = useMemo(() => messages.flatMap((message) => message.turn ? [message.turn] : []), [messages])

  useEffect(() => {
    void refresh()
    void loadFiles()
  }, [])

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    window.localStorage.setItem("pixiu.inspectorWidth", String(inspectorWidth))
  }, [inspectorWidth])

  async function refresh() {
    try {
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
        setOnboarding(true)
        setConfigOpen(true)
      }
      await loadSessions()
      await loadWorkbenchData()
    } catch (error) {
      setSessionsError(errorMessage(error))
    }
  }

  async function loadSessions() {
    setSessionsLoading(true)
    setSessionsError(undefined)
    try {
      const data = await api.listSessions()
      setSessions(data.sessions)
    } catch (error) {
      setSessionsError(errorMessage(error))
    } finally {
      setSessionsLoading(false)
    }
  }

  async function loadWorkbenchData() {
    const selectionGeneration = sessionSelectionGenerationRef.current
    const [projectData, skillData, mcpData] = await Promise.all([
      api.listProjects(),
      api.listSkills().catch(() => ({ skills: [] as UiSkillSummary[] })),
      api.listMcp().catch(() => ({ servers: [] as UiMcpServerSummary[] })),
    ])
    setProjects(projectData.projects)
    if (sessionSelectionGenerationRef.current === selectionGeneration) {
      setCurrentProjectId(projectData.currentProjectId)
    }
    setSkills(skillData.skills)
    setMcpServers(mcpData.servers)
  }

  async function loadSession(id: string) {
    sessionSelectionGenerationRef.current += 1
    sessionIdRef.current = id
    setSessionId(id)
    resetSessionView()
    setChatTitle("Loading chat")
    setRunId(runIdBySessionRef.current.get(id))
    setRunStatus(runStatusBySessionRef.current.get(id) ?? "idle")
    setPermission(permissionBySessionRef.current.get(id))
    setWorkbenchPanel("chat")
    setMobileNavOpen(false)
    try {
      const data = await api.getSession(id)
      if (sessionIdRef.current !== id) return
      if (data.session.projectId) setCurrentProjectId(data.session.projectId)
      setChatTitle(data.session.title ?? "Chat")
      setMessages(sessionMessages(data.messages, data.evidence, data.turns))
      setTrace(traceFromMessages(data.messages))
      setActivity(data.activity)
      setEvidence(data.evidence)
      setFiles(data.files)
      setTodoState(data.todos)
      setValidations(data.validations)
      setRunStatus(
        runIdBySessionRef.current.has(id)
          ? runStatusBySessionRef.current.get(id) ?? "running"
          : normalizePersistedRunStatus(data.session.finishStatus),
      )
      setPreview(undefined)
      setComposerReferences([])
      setUploadError(undefined)
      await loadSessions()
    } catch (error) {
      if (sessionIdRef.current === id) {
        setChatTitle("Chat unavailable")
        setSessionsError(errorMessage(error))
      }
    }
  }

  async function createSession(title = "New chat") {
    const selectionGeneration = sessionSelectionGenerationRef.current
    const data = await api.createSession({ title, ...(currentProjectId ? { projectId: currentProjectId } : {}) })
    const shouldSelect = sessionSelectionGenerationRef.current === selectionGeneration
    if (shouldSelect) {
      sessionSelectionGenerationRef.current += 1
      setSessionId(data.session.id)
      sessionIdRef.current = data.session.id
      resetSessionView()
      setChatTitle(data.session.title ?? "New chat")
      setFiles(data.files)
    }
    await loadSessions()
    await loadWorkbenchData()
    if (shouldSelect && sessionIdRef.current === data.session.id) {
      setWorkbenchPanel("chat")
      setMobileNavOpen(false)
    }
    return data.session.id
  }

  function beginNewChat() {
    sessionSelectionGenerationRef.current += 1
    sessionIdRef.current = undefined
    setSessionId(undefined)
    resetSessionView()
    setWorkbenchPanel("chat")
    setMobileNavOpen(false)
  }

  async function createProject(input: { name: string; rootPath?: string }) {
    const name = input.name.trim()
    if (!name) return
    try {
      const rootPath = input.rootPath?.trim()
      const data = await api.createProject({ name, ...(rootPath ? { rootPath } : {}) })
      setCurrentProjectId(data.project.id)
      await loadWorkbenchData()
      await loadSessions()
      setWorkbenchPanel("projects")
    } catch (error) {
      setSessionsError(errorMessage(error))
    }
  }

  async function renameProject(projectId: string, nameInput: string) {
    const name = nameInput.trim()
    if (!name) return
    try {
      await api.updateProject(projectId, { name })
      await loadWorkbenchData()
    } catch (error) {
      setSessionsError(errorMessage(error))
    }
  }

  async function removeProjectEntry(projectId: string) {
    try {
      await api.removeProjectEntry(projectId)
      await loadWorkbenchData()
      await loadSessions()
    } catch (error) {
      setSessionsError(errorMessage(error))
    }
  }

  async function selectProject(projectId: string) {
    const selectionGeneration = sessionSelectionGenerationRef.current + 1
    sessionSelectionGenerationRef.current = selectionGeneration
    try {
      await api.selectProject(projectId)
      if (sessionSelectionGenerationRef.current !== selectionGeneration) return
      setCurrentProjectId(projectId)
      sessionIdRef.current = undefined
      setSessionId(undefined)
      resetSessionView()
      setWorkbenchPanel("projects")
      setMobileNavOpen(false)
      await loadWorkbenchData()
      await loadSessions()
    } catch (error) {
      setSessionsError(errorMessage(error))
    }
  }

  async function renameSession(id: string, titleInput: string) {
    const title = titleInput.trim()
    if (!title) return
    try {
      const data = await api.updateSession(id, { title })
      setSessions((current) => current.map((item) => item.id === id ? data.session : item))
      if (sessionIdRef.current === id) setChatTitle(data.session.title ?? title)
      await loadWorkbenchData()
    } catch (error) {
      setSessionsError(errorMessage(error))
    }
  }

  async function moveSession(id: string, projectId: string) {
    if (!projectId) return
    try {
      const data = await api.moveSession(id, { projectId })
      setSessions((current) => current.map((item) => item.id === id ? data.session : item))
      await loadWorkbenchData()
    } catch (error) {
      setSessionsError(errorMessage(error))
    }
  }

  async function removeSessionFromList(id: string) {
    try {
      await api.removeSessionFromList(id)
      runIdBySessionRef.current.delete(id)
      runStatusBySessionRef.current.delete(id)
      permissionBySessionRef.current.delete(id)
      if (sessionIdRef.current === id) {
        sessionSelectionGenerationRef.current += 1
        sessionIdRef.current = undefined
        setSessionId(undefined)
        resetSessionView()
      }
      await loadSessions()
      await loadWorkbenchData()
    } catch (error) {
      setSessionsError(errorMessage(error))
    }
  }

  async function ensureSession(title?: string) {
    if (sessionIdRef.current) return sessionIdRef.current
    return await createSession(title)
  }

  async function loadFiles(seed?: UiFileSummary[]) {
    if (seed) {
      setFiles(seed)
      return
    }
    const selectedSessionId = sessionIdRef.current
    if (!selectedSessionId) return
    const data = await api.listFiles(selectedSessionId)
    if (sessionIdRef.current === selectedSessionId) setFiles(data.files)
  }

  async function previewFile(path: string, file?: { kind?: UiFileSummary["kind"] }) {
    const selectedSessionId = sessionIdRef.current
    if (!selectedSessionId) return
    setActiveTab("files")
    setPanelOpen(true)
    if (isPreviewUnsupported(path, file?.kind)) {
      setPreview({
        path,
        status: "unsupported",
        message: "Preview is not available for this file type yet.",
      })
      return
    }
    try {
      const data = await api.previewFile(selectedSessionId, path)
      if (sessionIdRef.current === selectedSessionId) setPreview({ path: data.path, content: data.content, status: "ready" })
    } catch (error) {
      if (sessionIdRef.current !== selectedSessionId) return
      const message = errorMessage(error)
      const unsupported = message.includes("Only text files") || message.includes("too large")
      setPreview({
        path,
        status: unsupported ? "unsupported" : "error",
        message: unsupported ? "Preview is not available for this file type yet." : message,
      })
    }
  }

  function resetSessionView() {
    setChatTitle("New chat")
    setMessages([])
    setTrace([])
    setActivity([])
    setEvidence(undefined)
    setFiles([])
    setTodoState([])
    setValidations([])
    setRunId(undefined)
    setRunStatus("idle")
    setPermission(undefined)
    setPreview(undefined)
    setComposerReferences([])
    setUploadError(undefined)
  }

  async function uploadFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    const selectionGeneration = sessionSelectionGenerationRef.current
    setUploadError(undefined)
    let targetSessionId: string | undefined
    try {
      const id = await ensureSession("Uploaded files")
      targetSessionId = id
      const data = await api.uploadFiles(id, fileList)
      if (sessionIdRef.current !== id) return
      setFiles((current) => mergeFileSummaries(data.files, current))
      addFileReferences(
        data.files.map((file) => ({
          path: file.path,
          name: fileNameFromPath(file.path),
          source: "uploaded",
          status: "uploaded",
          size: file.size,
          kind: file.kind,
        })),
      )
      pushTrace({ title: "Uploaded files", detail: data.files.map((file) => file.path).join("\n") })
      setActiveTab("files")
      setPanelOpen(true)
    } catch (error) {
      if (sessionSelectionGenerationRef.current !== selectionGeneration) return
      if (targetSessionId && sessionIdRef.current !== targetSessionId) return
      const message = errorMessage(error)
      setUploadError(message)
      pushTrace({ title: "Upload failed", detail: message, failed: true })
      setPanelOpen(true)
    }
  }

  async function saveProvider(closeAfter: boolean, patch: Partial<ProviderConfigPayload> = {}) {
    setConfigNotice({ text: "Saving..." })
    try {
      const baseURL = endpointPreset === "custom" ? providerForm.baseURL : ENDPOINTS[endpointPreset]
      const saved = await api.saveProvider({ ...providerForm, ...patch, baseURL })
      setProvider(saved.provider)
      setProviderForm((current) => ({ ...current, ...patch, apiKey: "" }))
      setConfigNotice({ text: "Provider saved.", kind: "ok" })
      await refresh()
      if (closeAfter) setConfigOpen(false)
      return true
    } catch (error) {
      setConfigNotice({ text: errorMessage(error), kind: "error" })
      return false
    }
  }

  async function testProvider() {
    try {
      if (!await saveProvider(false)) return
      setConfigNotice({ text: "Testing provider..." })
      const result = await api.testProvider()
      setConfigNotice({ text: `Provider test passed: ${result.text || result.model || "ok"}`, kind: "ok" })
      if (onboarding) {
        setOnboarding(false)
        setConfigOpen(false)
      }
    } catch (error) {
      setConfigNotice({ text: errorMessage(error), kind: "error" })
    }
  }

  async function selectModel(model: string) {
    if (!model || model === provider?.model || modelChanging) return
    setModelChanging(true)
    try {
      await saveProvider(false, { model })
    } finally {
      setModelChanging(false)
    }
  }

  async function sendPrompt(override?: { message: string }) {
    const selectionGeneration = sessionSelectionGenerationRef.current
    const promptText = (override?.message ?? prompt).trim()
    const references = override ? [] : [...composerReferences]
    const message = promptText
    const trackedSessionRun = sessionIdRef.current ? runIdBySessionRef.current.get(sessionIdRef.current) : undefined
    if (!message || runId || trackedSessionRun || isActiveRunStatus(runStatus)) return
    if (provider && !provider.keyPresent) {
      setConfigNotice({ text: "Add an API key before sending." })
      setConfigOpen(true)
      return
    }
    let targetSessionId: string | undefined
    let targetRunId: string | undefined
    try {
      const id = sessionId ?? await createSession(message.slice(0, 60) || references[0]?.path || "New chat")
      targetSessionId = id
      const turnId = nextMessageId("turn")
      if (sessionIdRef.current === id) {
        setPrompt("")
        setComposerReferences([])
        setUploadError(undefined)
        setMessages((current) => [
          ...current,
          {
            id: `${turnId}_user`,
            role: "user",
            text: promptText,
            ...(references.length ? { attachments: references } : {}),
          },
          { id: `${turnId}_assistant`, role: "assistant", text: "", pending: true, tools: [], artifacts: [] },
        ])
        setRunStatus("queued")
      }
      const started = await api.startRun({
        message,
        sessionId: id,
        permissionMode,
        references: references.map(({ path, source, startLine, endLine }) => ({
          path,
          source,
          ...(startLine !== undefined ? { startLine } : {}),
          ...(endLine !== undefined ? { endLine } : {}),
        })),
      })
      targetRunId = started.runId
      const startedStatus = normalizeRunStatus(started.status) ?? "queued"
      runIdBySessionRef.current.set(id, started.runId)
      runStatusBySessionRef.current.set(id, startedStatus)
      if (sessionIdRef.current !== id) {
        void subscribeRun(started.runId, id).catch(() => undefined)
        return
      }
      setRunId(started.runId)
      setRunStatus(startedStatus)
      await subscribeRun(started.runId, id)
    } catch (error) {
      if (!targetSessionId && sessionSelectionGenerationRef.current !== selectionGeneration) return
      const trackedRunId = targetSessionId ? runIdBySessionRef.current.get(targetSessionId) : undefined
      const newerRunOwnsSession = Boolean(targetRunId && trackedRunId && trackedRunId !== targetRunId)
      if (!newerRunOwnsSession && (!targetSessionId || sessionIdRef.current === targetSessionId)) {
        replacePending(`Error: ${errorMessage(error)}`, targetSessionId)
        pushTrace({ title: "Error", detail: errorMessage(error), failed: true }, targetSessionId)
        setRunStatus("error")
        setPanelOpen(true)
      }
    } finally {
      if (!targetSessionId && sessionSelectionGenerationRef.current !== selectionGeneration) return
      const trackedRunId = targetSessionId ? runIdBySessionRef.current.get(targetSessionId) : undefined
      const newerRunOwnsSession = Boolean(targetRunId && trackedRunId && trackedRunId !== targetRunId)
      if (!newerRunOwnsSession && (!targetSessionId || sessionIdRef.current === targetSessionId)) {
        setRunId(undefined)
        setRunStatus((current) => isActiveRunStatus(current) ? "idle" : current)
      }
    }
  }

  function editMessage(message: ChatMessage) {
    setWorkbenchPanel("chat")
    setPrompt(message.text)
    setComposerReferences(message.attachments ?? [])
  }

  async function retryTurn(turnId: string, anotherModel: boolean) {
    const targetSessionId = sessionIdRef.current
    const trackedSessionRun = targetSessionId ? runIdBySessionRef.current.get(targetSessionId) : undefined
    if (!targetSessionId || runId || trackedSessionRun || isActiveRunStatus(runStatus)) return
    const assistantIndex = messages.findIndex((message) => message.role === "assistant" && message.turn?.id === turnId)
    if (assistantIndex < 0) return
    let userMessage: ChatMessage | undefined
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        userMessage = messages[index]
        break
      }
    }
    if (!userMessage) return
    const currentModel = messages[assistantIndex]?.turn?.model ?? provider?.model
    const model = anotherModel
      ? MODEL_OPTIONS.find((candidate) => candidate !== currentModel) ?? currentModel
      : currentModel
    const references = userMessage.attachments ?? []
    const optimisticId = nextMessageId("retry")
    let targetRunId: string | undefined
    setMessages((current) => [
      ...current,
      { ...userMessage, id: `${optimisticId}_user`, turnId: undefined },
      { id: `${optimisticId}_assistant`, role: "assistant", text: "", pending: true, tools: [], artifacts: [] },
    ])
    setRunStatus("queued")
    try {
      const started = await api.startRun({
        message: userMessage.text,
        sessionId: targetSessionId,
        permissionMode,
        ...(model ? { model } : {}),
        retryOf: turnId,
        references: references.map(({ path, source, startLine, endLine }) => ({
          path,
          source,
          ...(startLine !== undefined ? { startLine } : {}),
          ...(endLine !== undefined ? { endLine } : {}),
        })),
      })
      targetRunId = started.runId
      const startedStatus = normalizeRunStatus(started.status) ?? "queued"
      runIdBySessionRef.current.set(targetSessionId, started.runId)
      runStatusBySessionRef.current.set(targetSessionId, startedStatus)
      if (sessionIdRef.current !== targetSessionId) {
        void subscribeRun(started.runId, targetSessionId).catch(() => undefined)
        return
      }
      setRunId(started.runId)
      setRunStatus(startedStatus)
      await subscribeRun(started.runId, targetSessionId)
    } catch (error) {
      const tracked = runIdBySessionRef.current.get(targetSessionId)
      if (!targetRunId || !tracked || tracked === targetRunId) {
        replacePending(`Error: ${errorMessage(error)}`, targetSessionId)
        setRunStatus("error")
      }
    } finally {
      const tracked = runIdBySessionRef.current.get(targetSessionId)
      if ((!targetRunId || !tracked || tracked === targetRunId) && sessionIdRef.current === targetSessionId) {
        setRunId(undefined)
        setRunStatus((current) => isActiveRunStatus(current) ? "idle" : current)
      }
    }
  }

  async function rollbackTurn(turnId: string) {
    const targetSessionId = sessionIdRef.current
    if (!targetSessionId || runIdBySessionRef.current.has(targetSessionId) || isActiveRunStatus(runStatus)) return
    if (!window.confirm("Restore the session files to their state before this turn? The real project is not changed.")) return
    try {
      await api.rollbackTurn(targetSessionId, turnId)
      window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT))
      await loadSession(targetSessionId)
      pushTrace({ title: "Workspace restored", detail: `Restored files to the checkpoint before ${turnId}.` }, targetSessionId)
    } catch (error) {
      pushTrace({ title: "Restore failed", detail: errorMessage(error), failed: true }, targetSessionId)
      setPanelOpen(true)
    }
  }

  async function fixValidation(record: UiValidationRecord) {
    const output = record.output.trim() || `Command exited with code ${record.exitCode}.`
    setWorkbenchPanel("chat")
    setPanelOpen(false)
    setInspectorCollapsed(true)
    await sendPrompt({
      message: [
        `Fix the ${record.kind} validation failure from turn ${record.turnId}.`,
        `Command: ${record.command}`,
        `Exit code: ${record.exitCode}`,
        "Output:",
        output,
        "Inspect the current session changes, make the smallest correct fix, and rerun the relevant validation.",
      ].join("\n"),
    })
  }

  function subscribeRun(id: string, targetSessionId: string) {
    return new Promise<void>((resolve) => {
      const source = api.eventSource(id)
      let settled = false
      let lastFailure: string | undefined
      let reconnecting = false
      const selected = () => sessionIdRef.current === targetSessionId
      const ownsRun = () => runIdBySessionRef.current.get(targetSessionId) === id
      source.onopen = () => {
        if (!reconnecting) return
        reconnecting = false
        pushTrace({ title: "Run stream restored", detail: "Resumed from the last received event." }, targetSessionId)
      }
      source.addEventListener("run_status", (event) => {
        if (!ownsRun()) return
        const data = JSON.parse(event.data) as RunStatusEvent
        runStatusBySessionRef.current.set(targetSessionId, data.status)
        if (isTerminalRunStatus(data.status)) {
          permissionBySessionRef.current.delete(targetSessionId)
        }
        if (!selected()) return
        setRunStatus(data.status)
        if (isTerminalRunStatus(data.status)) {
          setPermission(undefined)
        }
      })
      source.addEventListener("run", (event) => {
        if (!ownsRun()) return
        const data = JSON.parse(event.data) as { status?: unknown; runStatus?: unknown }
        const status = normalizeRunStatus(data.runStatus) ?? normalizeRunStatus(data.status)
        if (status) runStatusBySessionRef.current.set(targetSessionId, status)
        if (status && selected()) setRunStatus(status)
      })
      source.addEventListener("activity_updated", (event) => {
        if (!ownsRun() || !selected()) return
        const data = JSON.parse(event.data) as ActivityUpdatedEvent
        setActivity((current) => mergeActivityItems(current, data.activity))
      })
      source.addEventListener("agent_event", (event) => {
        if (!ownsRun()) return
        const agentEvent = JSON.parse(event.data) as AgentEvent
        const failure = failureMessageFromAgentEvent(agentEvent)
        if (failure) lastFailure = failure
        applyAgentEvent(agentEvent, targetSessionId)
      })
      source.addEventListener("permission_request", (event) => {
        if (!ownsRun()) return
        const next = { ...(JSON.parse(event.data) as PermissionView), sessionId: targetSessionId }
        permissionBySessionRef.current.set(targetSessionId, next)
        if (selected()) setPermission(next)
      })
      source.addEventListener("permission_result", (event) => {
        if (!ownsRun()) return
        const data = JSON.parse(event.data) as { id?: string }
        const current = permissionBySessionRef.current.get(targetSessionId)
        if (data.id && current?.id === data.id) permissionBySessionRef.current.delete(targetSessionId)
        if (selected() && data.id) {
          setPermission((value) => value?.id === data.id ? undefined : value)
        }
        pushTrace({ title: "permission", detail: JSON.stringify(data, null, 2), kind: "permission" }, targetSessionId)
      })
      source.addEventListener("result", (event) => {
        const result = JSON.parse(event.data) as UiRunResult
        settled = true
        source.close()
        const wasCurrentRun = ownsRun()
        if (wasCurrentRun) {
          runIdBySessionRef.current.delete(targetSessionId)
          runStatusBySessionRef.current.delete(targetSessionId)
          permissionBySessionRef.current.delete(targetSessionId)
        }
        if (wasCurrentRun && selected()) {
          setRunId(undefined)
          setRunStatus(normalizeRunStatus(result.status) ?? "idle")
          setPermission(undefined)
          replacePending(assistantTextFromRunResult(result, lastFailure), targetSessionId)
        }
        if (wasCurrentRun && result.sessionId) {
          void api.getSession(result.sessionId).then((detail) => {
            if (!selected() || runIdBySessionRef.current.has(targetSessionId)) return
            setChatTitle(detail.session.title ?? "Chat")
            if (detail.session.projectId) setCurrentProjectId(detail.session.projectId)
            setEvidence(detail.evidence)
            setFiles(detail.files)
            setTodoState(detail.todos)
            setActivity(detail.activity)
            setTrace(traceFromMessages(detail.messages))
            setMessages(sessionMessages(detail.messages, detail.evidence, detail.turns))
            setValidations(detail.validations)
          })
        }
        if (wasCurrentRun) {
          pushTrace({
            title: "Run finished",
            detail: `status: ${result.status}\nfinishReason: ${result.finishReason ?? "unknown"}\nsessionId: ${result.sessionId ?? "new"}`,
            failed: result.status === "error" || result.status === "cancelled",
          }, targetSessionId)
        }
        void loadSessions()
        window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT))
        resolve()
      })
      source.onerror = (event) => {
        const failure = failureMessageFromRunErrorEvent(event)
        if (failure) {
          lastFailure = failure
          return
        }
        if (settled) return
        if (!reconnecting) {
          reconnecting = true
          pushTrace({ title: "Run stream interrupted", detail: "Reconnecting from the last received event..." }, targetSessionId)
        }
        void api.getRunStatus(id).then((snapshot) => {
          if (snapshot.found || settled || !ownsRun()) return
          settled = true
          source.close()
          runIdBySessionRef.current.delete(targetSessionId)
          runStatusBySessionRef.current.delete(targetSessionId)
          permissionBySessionRef.current.delete(targetSessionId)
          if (selected()) {
            setRunId(undefined)
            setRunStatus("idle")
            setPermission(undefined)
            replacePending(staleRunMessage(lastFailure), targetSessionId)
          }
          pushTrace({
            title: "Run stopped",
            detail: "The local Pixiu service restarted and no longer has this run.",
            failed: true,
          }, targetSessionId)
          resolve()
        }).catch(() => undefined)
      }
    })
  }

  function applyAgentEvent(event: AgentEvent, targetSessionId: string) {
    if (sessionIdRef.current !== targetSessionId) return
    if (event.type === "session_created") {
      setChatTitle("Working chat")
      void loadSessions()
    }
    if (todoUpdateMatchesSession(event, targetSessionId)) {
      setTodos(event.todos)
      setCurrentTodoId(event.currentTodoId ?? currentTodoIdFromTodos(event.todos))
    }
    if (event.type === "llm_text_delta") appendAssistantDelta(event.text, targetSessionId)
    if (event.type === "message") replacePending(event.content, targetSessionId)
    if (event.type === "assistant_progress_delta") pushTrace({ title: "progress", detail: event.text, kind: "thinking" }, targetSessionId)
    if (event.type === "tool_call") {
      pushTrace({ title: `tool ${event.name}`, detail: JSON.stringify(event.input, null, 2), kind: "call" }, targetSessionId)
      updateAssistantTurn((message) => ({
        ...message,
        tools: [
          ...(message.tools ?? []).filter((tool) => tool.id !== event.id),
          { id: event.id, name: event.name, status: "running", detail: JSON.stringify(event.input, null, 2) },
        ],
      }), targetSessionId)
    }
    if (event.type === "tool_result") {
      pushTrace({ title: `${event.ok ? "ok" : "failed"} ${event.name}`, detail: event.content, kind: "result", failed: !event.ok }, targetSessionId)
      updateAssistantTurn((message) => {
        const tools = [...(message.tools ?? [])]
        const index = tools.findIndex((tool) => tool.id === event.id)
        const tool = { id: event.id, name: event.name, status: event.ok ? "success" as const : "failed" as const, detail: event.content }
        if (index >= 0) tools[index] = tool
        else tools.push(tool)
        const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) ? event.metadata : undefined
        const path = metadata && typeof metadata.path === "string" ? metadata.path : undefined
        const artifact = path && ["write", "edit", "patch"].includes(event.name)
          ? { kind: "artifact" as const, tool: event.name, label: path, path }
          : undefined
        return {
          ...message,
          tools,
          artifacts: artifact
            ? [...(message.artifacts ?? []).filter((item) => item.path !== path), artifact]
            : message.artifacts,
        }
      }, targetSessionId)
    }
    if (event.type === "error") pushTrace({ title: "agent error", detail: event.message, failed: true }, targetSessionId)
  }

  function setTodoState(nextTodos: TodoItem[] | undefined) {
    const normalized = normalizeTodos(nextTodos)
    setTodos(normalized)
    setCurrentTodoId(currentTodoIdFromTodos(normalized))
  }

  function appendAssistantDelta(text: string, targetSessionId: string) {
    updateAssistantTurn((last) => ({ ...last, text: last.pending ? text : `${last.text}${text}`, pending: false }), targetSessionId)
  }

  function replacePending(text: string, targetSessionId?: string) {
    if (targetSessionId && sessionIdRef.current !== targetSessionId) return
    setMessages((current) => {
      const next = [...current]
      const last = next[next.length - 1]
      if (!last || last.role !== "assistant") return [...next, { id: nextMessageId("assistant"), role: "assistant", text }]
      next[next.length - 1] = { ...last, text, pending: false }
      return next
    })
  }

  function updateAssistantTurn(update: (message: ChatMessage) => ChatMessage, targetSessionId: string) {
    if (sessionIdRef.current !== targetSessionId) return
    setMessages((current) => {
      const next = [...current]
      const index = next.findLastIndex((message) => message.role === "assistant")
      if (index < 0) return [...next, update({ id: nextMessageId("assistant"), role: "assistant", text: "", pending: true })]
      next[index] = update(next[index])
      return next
    })
  }

  function pushTrace(item: Omit<TraceItem, "id">, targetSessionId?: string) {
    if (targetSessionId && sessionIdRef.current !== targetSessionId) return
    setTrace((current) => [{ id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, ...item }, ...current].slice(0, 80))
  }

  async function answerPermission(action: "allow" | "deny", scope: "once" | "sessionSimilar") {
    if (!permission || permission.submitting) return
    const current = permission
    const submitting = { ...current, submitting: true, error: undefined }
    if (current.sessionId && permissionBySessionRef.current.get(current.sessionId)?.id === current.id) {
      permissionBySessionRef.current.set(current.sessionId, submitting)
    }
    setPermission((value) => value?.id === current.id ? submitting : value)
    try {
      await api.answerPermission(current.id, { action, scope })
      if (current.sessionId && permissionBySessionRef.current.get(current.sessionId)?.id === current.id) {
        permissionBySessionRef.current.delete(current.sessionId)
      }
      if (!current.sessionId || sessionIdRef.current === current.sessionId) {
        setPermission((value) => value?.id === current.id ? undefined : value)
      }
    } catch (error) {
      const recovered = { ...current, submitting: false, error: errorMessage(error) }
      const stillTracked = !current.sessionId || permissionBySessionRef.current.get(current.sessionId)?.id === current.id
      if (current.sessionId && stillTracked) permissionBySessionRef.current.set(current.sessionId, recovered)
      if (stillTracked && (!current.sessionId || sessionIdRef.current === current.sessionId)) {
        setPermission((value) => value?.id === current.id ? recovered : value)
      }
    }
  }

  async function cancelRun() {
    const targetRunId = runId
    const targetSessionId = sessionIdRef.current
    if (!targetRunId || !targetSessionId) return
    try {
      await api.cancelRun(targetRunId)
      if (runIdBySessionRef.current.get(targetSessionId) !== targetRunId) return
      runStatusBySessionRef.current.set(targetSessionId, "cancelled")
      if (sessionIdRef.current === targetSessionId) setRunStatus("cancelled")
    } catch (error) {
      if (runIdBySessionRef.current.get(targetSessionId) !== targetRunId || sessionIdRef.current !== targetSessionId) return
      pushTrace({ title: "Cancel failed", detail: errorMessage(error), failed: true }, targetSessionId)
      setPanelOpen(true)
    }
  }

  const providerReady = provider?.keyPresent === true

  function openInspector(tab: InspectorTab) {
    setActiveTab(tab)
    setInspectorCollapsed(false)
    setPanelOpen(true)
  }

  function addFileReferences(nextReferences: FileReference[]) {
    setComposerReferences((current) => {
      const next = [...current]
      for (const reference of nextReferences) {
        const index = next.findIndex((item) => fileReferenceKey(item) === fileReferenceKey(reference))
        if (index >= 0) {
          next[index] = { ...next[index], ...reference }
        } else {
          next.push(reference)
        }
      }
      return next
    })
  }

  function referenceFile(file: UiFileSummary, source: FileReferenceSource = "workspace", range: FileReferenceRange = {}) {
    addFileReferences([
      {
        path: file.path,
        name: fileNameFromPath(file.path),
        source,
        status: "referenced",
        size: file.size,
        kind: file.kind,
        ...range,
      },
    ])
  }

  function removeComposerReference(reference: FileReference) {
    setComposerReferences((current) => current.filter((item) => fileReferenceKey(item) !== fileReferenceKey(reference)))
  }

  function fileReferenceKey(reference: FileReference) {
    return `${reference.source}:${reference.path}:${reference.startLine ?? ""}:${reference.endLine ?? ""}`
  }

  function mergeFileSummaries(primary: UiFileSummary[], secondary: UiFileSummary[]) {
    const byPath = new Map<string, UiFileSummary>()
    for (const file of secondary) byPath.set(file.path, file)
    for (const file of primary) byPath.set(file.path, file)
    return [...byPath.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  function mergeActivityItems(current: ActivityItem[], incoming: ActivityItem[]) {
    const byId = new Map(current.map((item) => [item.id, item]))
    for (const item of incoming) byId.set(item.id, item)
    return limitActivityItems([...byId.values()])
  }

  // Opens the folder picker and resolves with the chosen absolute path (or undefined on cancel).
  function browseFolder(): Promise<string | undefined> {
    return new Promise((resolve) => setFolderPicker({ resolve }))
  }

  function closeFolderPicker(path?: string) {
    folderPicker?.resolve(path)
    setFolderPicker(undefined)
  }

  return (
    <WorkbenchLayout
      sidebarCollapsed={sidebarCollapsed}
      inspectorCollapsed={inspectorCollapsed}
      mobileNavOpen={mobileNavOpen}
      inspectorWidth={inspectorWidth}
      onCloseMobileNav={() => setMobileNavOpen(false)}
      sidebar={
        <AppSidebar
          sessions={sessions}
          projects={projects}
          currentProjectId={currentProjectId}
          skillCount={skills.length}
          activePanel={workbenchPanel}
          sessionId={sessionId}
          providerReady={providerReady}
          workspace={statusSummary.workspace}
          status={statusSummary}
          sessionsLoading={sessionsLoading}
          sessionsError={sessionsError}
          collapsed={sidebarCollapsed}
          mobileOpen={mobileNavOpen}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onCloseMobileNav={() => setMobileNavOpen(false)}
          onNewChat={beginNewChat}
          onOpenPanel={setWorkbenchPanel}
          onSelectProject={(id) => void selectProject(id)}
          onCreateProject={(input) => void createProject(input)}
          onBrowseFolder={browseFolder}
          onRenameProject={(id, name) => void renameProject(id, name)}
          onRemoveProjectEntry={(id) => void removeProjectEntry(id)}
          onRenameSession={(id, title) => void renameSession(id, title)}
          onRemoveSessionFromList={(id) => void removeSessionFromList(id)}
          onMoveSession={(id, projectId) => void moveSession(id, projectId)}
          onConfigureApi={() => setConfigOpen(true)}
          onLoadSession={(id) => void loadSession(id)}
        />
      }
      topBar={
        <TopBar
          chatTitle={chatTitle}
          cwd={projects.find((project) => project.id === currentProjectId)?.rootPath ?? statusSummary.cwd}
          model={provider?.model}
          models={MODEL_OPTIONS}
          modelChanging={modelChanging}
          runStatus={runStatus}
          runStatusLabel={runStatusLabel(runStatus)}
          navigationOpen={mobileNavOpen}
          inspectorOpen={panelOpen && !inspectorCollapsed}
          onOpenNavigation={() => setMobileNavOpen(true)}
          onModelChange={(model) => void selectModel(model)}
          onToggleInspector={() => {
            if (panelOpen && !inspectorCollapsed) {
              setPanelOpen(false)
              setInspectorCollapsed(true)
            } else {
              openInspector(activeTab)
            }
          }}
        />
      }
      configModal={
        <ConfigModal
          open={configOpen}
          onboarding={onboarding}
          close={() => { if (!onboarding) setConfigOpen(false) }}
          notice={configNotice}
          form={providerForm}
          setForm={setProviderForm}
          endpointPreset={endpointPreset}
          setEndpointPreset={setEndpointPreset}
          save={() => void saveProvider(true)}
          test={() => void testProvider()}
          projects={projects}
          currentProjectId={currentProjectId}
          selectProject={(projectId) => void selectProject(projectId)}
        />
      }
      permissionModal={
        <>
          <PermissionModal permission={permission} answer={(action, scope) => void answerPermission(action, scope)} />
          {folderPicker ? (
            <FolderPicker
              listDir={(path) => api.listDir(path)}
              onSelect={(path) => closeFolderPicker(path)}
              onClose={() => closeFolderPicker(undefined)}
            />
          ) : null}
        </>
      }
    >
      {workbenchPanel === "chat" ? (
        <ChatPane
          messages={messages}
          setPrompt={setPrompt}
          prompt={prompt}
          sendPrompt={sendPrompt}
          fileInputRef={fileInputRef}
          uploadFiles={uploadFiles}
          permissionMode={permissionMode}
          setPermissionMode={setPermissionMode}
          runStatus={runStatus}
          runStatusLabel={runStatusLabel(runStatus)}
          runId={runId}
          cancelRun={cancelRun}
          composerReferences={composerReferences}
          uploadError={uploadError}
          removeComposerReference={removeComposerReference}
          previewReference={(reference) => void previewFile(reference.path, reference)}
          files={files}
          previewFile={(file) => void previewFile(file.path, file)}
          editMessage={editMessage}
          retryTurn={retryTurn}
          rollbackTurn={rollbackTurn}
          validations={validations}
          fixValidation={(record) => void fixValidation(record)}
        />
      ) : (
        <WorkbenchPanelView
          panel={workbenchPanel}
          projects={projects}
          currentProjectId={currentProjectId}
          sessionId={sessionId}
          sessions={sessions}
          skills={skills}
          mcpServers={mcpServers}
          files={files}
          preview={preview}
          evidence={evidence}
          turns={turns}
          validations={validations}
          status={statusSummary}
          providerReady={providerReady}
          onCreateProject={(input) => void createProject(input)}
          onRenameProject={(id, name) => void renameProject(id, name)}
          onRemoveProjectEntry={(id) => void removeProjectEntry(id)}
          onSelectProject={(id) => void selectProject(id)}
          onBrowseFolder={browseFolder}
          onCreateSession={beginNewChat}
          onLoadSession={(id) => void loadSession(id)}
          onRenameSession={(id, title) => void renameSession(id, title)}
          onRemoveSessionFromList={(id) => void removeSessionFromList(id)}
          onMoveSession={(id, projectId) => void moveSession(id, projectId)}
          onPreviewFile={(file) => void previewFile(file.path, file)}
          onReferenceFile={referenceFile}
          onValidationsChange={setValidations}
          onFixValidation={(record) => void fixValidation(record)}
          onConfigureApi={() => setConfigOpen(true)}
          onRefresh={() => { void loadWorkbenchData(); void loadSessions(); void loadFiles() }}
        />
      )}
      <RightInspector
        open={panelOpen}
        collapsed={inspectorCollapsed}
        inspectorWidth={inspectorWidth}
        currentProjectId={currentProjectId}
        sessionId={sessionId}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        close={() => { setPanelOpen(false); setInspectorCollapsed(true) }}
        trace={trace}
        activity={activity}
        files={files}
        preview={preview}
        evidence={evidence}
        turns={turns}
        validations={validations}
        status={statusSummary}
        todos={todos}
        currentTodoId={currentTodoId}
        onPreview={(file) => void previewFile(file.path, file)}
        onReference={referenceFile}
        onValidationsChange={setValidations}
        onFixValidation={(record) => void fixValidation(record)}
        onResize={(width) => setInspectorWidth(Math.min(620, Math.max(300, width)))}
      />
    </WorkbenchLayout>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<App />)

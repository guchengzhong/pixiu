import type {
  ApiResponse,
  RunStatus,
  UiConfigResponse,
  UiChangeSetDiff,
  UiChangeMutationResult,
  UiChangeSelection,
  UiChangeSetSnapshot,
  UiFileSummary,
  UiMcpServerSummary,
  UiProjectSummary,
  UiProviderSummary,
  UiFsListing,
  UiRunResult,
  UiSessionDetail,
  UiSessionSummary,
  UiSkillSummary,
  UiStatus,
  UiValidationKind,
  UiValidationRecord,
  UiWorkspaceDiff,
  UiWorkspaceFileContent,
  UiWorkspaceSnapshot,
} from "../shared/api"

export const WORKSPACE_CHANGED_EVENT = "pixiu:workspace-changed"

export type UiApiClient = {
  status(): Promise<UiStatus>
  config(): Promise<UiConfigResponse>
  saveProvider(input: ProviderConfigPayload): Promise<{ provider: UiProviderSummary }>
  testProvider(): Promise<{ ok: true; model: string; text: string }>
  listProjects(): Promise<{ projects: UiProjectSummary[]; currentProjectId: string }>
  createProject(input: { name?: string; rootPath?: string }): Promise<{ project: UiProjectSummary }>
  updateProject(projectId: string, input: { name?: string; rootPath?: string }): Promise<{ project: UiProjectSummary }>
  selectProject(projectId: string): Promise<{ project: UiProjectSummary }>
  removeProjectEntry(projectId: string): Promise<{ project: UiProjectSummary }>
  listSessions(): Promise<{ sessions: UiSessionSummary[] }>
  createSession(input: { title?: string; projectId?: string }): Promise<{ session: UiSessionSummary; files: UiFileSummary[] }>
  getSession(sessionId: string): Promise<UiSessionDetail>
  updateSession(sessionId: string, input: { title: string }): Promise<{ session: UiSessionSummary }>
  removeSessionFromList(sessionId: string): Promise<{ session: UiSessionSummary }>
  moveSession(sessionId: string, input: { projectId: string }): Promise<{ session: UiSessionSummary }>
  workspace(projectId?: string): Promise<UiWorkspaceSnapshot>
  previewWorkspaceFile(path: string, projectId?: string): Promise<UiWorkspaceFileContent>
  diffWorkspaceFile(path: string, projectId?: string): Promise<UiWorkspaceDiff>
  sessionChanges(sessionId: string): Promise<UiChangeSetSnapshot>
  sessionChangeDiff(sessionId: string, path: string): Promise<UiChangeSetDiff>
  applySessionChanges(sessionId: string, input: { revision: string; selections: UiChangeSelection[] }): Promise<UiChangeMutationResult>
  discardSessionChanges(sessionId: string, input: { revision: string; selections: UiChangeSelection[] }): Promise<UiChangeMutationResult>
  undoSessionChanges(sessionId: string, input: { revision: string }): Promise<UiChangeMutationResult>
  stageSessionChanges(sessionId: string, input: { revision: string; selections: UiChangeSelection[] }): Promise<UiChangeMutationResult>
  unstageSessionChanges(sessionId: string, input: { revision: string; selections: UiChangeSelection[] }): Promise<UiChangeMutationResult>
  commitSessionChanges(sessionId: string, input: { revision: string; message: string }): Promise<UiChangeMutationResult>
  sessionValidations(sessionId: string): Promise<{ validations: UiValidationRecord[] }>
  runSessionValidation(sessionId: string, input: { turnId: string; kind: UiValidationKind; command?: string; confirmed?: boolean }): Promise<{
    record: UiValidationRecord
    validations: UiValidationRecord[]
    currentRevision: string
  }>
  rollbackTurn(sessionId: string, turnId: string): Promise<{ turnId: string; checkpointId: string; changes: UiChangeSetSnapshot }>
  listFiles(sessionId: string): Promise<{ files: UiFileSummary[] }>
  previewFile(sessionId: string, path: string): Promise<{ path: string; size: number; updatedAt: string; content: string }>
  uploadFiles(sessionId: string, files: FileList | File[]): Promise<{ files: UiFileSummary[] }>
  listSkills(): Promise<{ skills: UiSkillSummary[] }>
  listMcp(): Promise<{ servers: UiMcpServerSummary[] }>
  startRun(input: {
    message: string
    sessionId?: string
    permissionMode: string
    model?: string
    retryOf?: string
    references?: Array<{ path: string; source: "uploaded" | "workspace" | "generated" | "evidence"; startLine?: number; endLine?: number }>
  }): Promise<{ runId: string; turnId: string; status: RunStatus }>
  getRunStatus(runId: string): Promise<{ found: boolean; status?: RunStatus }>
  cancelRun(runId: string): Promise<{ runId: string; status: RunStatus }>
  answerPermission(id: string, input: { action: "allow" | "deny"; scope: "once" | "sessionSimilar" }): Promise<{ id: string; action: string }>
  listDir(path?: string): Promise<UiFsListing>
  eventSource(runId: string): EventSource
}

export type ProviderConfigPayload = {
  baseURL: string
  model: string
  credential: "apiKey" | "apiKeyEnv"
  apiKey?: string
  apiKeyEnv?: string
}

type UiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function resolveUiToken(injectedToken: string | undefined, search = typeof window !== "undefined" ? window.location.search : "") {
  return injectedToken || new URLSearchParams(search).get("token") || ""
}

export function createUiApiClient(token: string, fetchImpl: UiFetch = fetch): UiApiClient {
  const withTokenQuery = (path: string) => {
    if (!token) return path
    return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
  }

  const requestJson = async <T>(path: string, init: RequestInit = {}) => {
    const response = await fetchImpl(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    const body = (await response.json()) as ApiResponse<T>
    if (!body.ok) throw new Error(body.message)
    return body.data
  }

  const workspacePath = (path: string, input: { projectId?: string; filePath?: string } = {}) => {
    const search = new URLSearchParams()
    if (input.projectId) search.set("projectId", input.projectId)
    if (input.filePath) search.set("path", input.filePath)
    const suffix = search.toString()
    return suffix ? `${path}?${suffix}` : path
  }

  const notifyWorkspaceChanged = () => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT))
  }

  return {
    status: () => requestJson<UiStatus>("/api/status"),
    config: () => requestJson<UiConfigResponse>("/api/config"),
    saveProvider: (input) =>
      requestJson<{ provider: UiProviderSummary }>("/api/config/provider", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    testProvider: () =>
      requestJson<{ ok: true; model: string; text: string }>("/api/config/test-provider", {
        method: "POST",
        body: "{}",
      }),
    listProjects: () => requestJson<{ projects: UiProjectSummary[]; currentProjectId: string }>("/api/projects"),
    async createProject(input) {
      const result = await requestJson<{ project: UiProjectSummary }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(input),
      })
      notifyWorkspaceChanged()
      return result
    },
    async updateProject(projectId, input) {
      const result = await requestJson<{ project: UiProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      })
      notifyWorkspaceChanged()
      return result
    },
    async selectProject(projectId) {
      const result = await requestJson<{ project: UiProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}/select`, {
        method: "POST",
        body: "{}",
      })
      notifyWorkspaceChanged()
      return result
    },
    async removeProjectEntry(projectId) {
      const result = await requestJson<{ project: UiProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        body: "{}",
      })
      notifyWorkspaceChanged()
      return result
    },
    listSessions: () => requestJson<{ sessions: UiSessionSummary[] }>("/api/sessions"),
    createSession: (input) =>
      requestJson<{ session: UiSessionSummary; files: UiFileSummary[] }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    getSession: (sessionId) => requestJson<UiSessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`),
    updateSession: (sessionId, input) =>
      requestJson<{ session: UiSessionSummary }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    removeSessionFromList: (sessionId) =>
      requestJson<{ session: UiSessionSummary }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        body: "{}",
      }),
    moveSession: (sessionId, input) =>
      requestJson<{ session: UiSessionSummary }>(`/api/sessions/${encodeURIComponent(sessionId)}/move`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    workspace: (projectId) => requestJson<UiWorkspaceSnapshot>(workspacePath("/api/workspace", projectId ? { projectId } : {})),
    previewWorkspaceFile: (path, projectId) =>
      requestJson<UiWorkspaceFileContent>(workspacePath("/api/workspace/content", { filePath: path, ...(projectId ? { projectId } : {}) })),
    diffWorkspaceFile: (path, projectId) =>
      requestJson<UiWorkspaceDiff>(workspacePath("/api/workspace/diff", { filePath: path, ...(projectId ? { projectId } : {}) })),
    sessionChanges: (sessionId) => requestJson<UiChangeSetSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/changes`),
    sessionChangeDiff: (sessionId, path) => requestJson<UiChangeSetDiff>(
      `/api/sessions/${encodeURIComponent(sessionId)}/changes/diff?path=${encodeURIComponent(path)}`,
    ),
    async applySessionChanges(sessionId, input) {
      const result = await requestJson<UiChangeMutationResult>(`/api/sessions/${encodeURIComponent(sessionId)}/changes/apply`, {
        method: "POST",
        body: JSON.stringify(input),
      })
      notifyWorkspaceChanged()
      return result
    },
    async discardSessionChanges(sessionId, input) {
      const result = await requestJson<UiChangeMutationResult>(`/api/sessions/${encodeURIComponent(sessionId)}/changes/discard`, {
        method: "POST",
        body: JSON.stringify(input),
      })
      notifyWorkspaceChanged()
      return result
    },
    async undoSessionChanges(sessionId, input) {
      const result = await requestJson<UiChangeMutationResult>(`/api/sessions/${encodeURIComponent(sessionId)}/changes/undo`, {
        method: "POST",
        body: JSON.stringify(input),
      })
      notifyWorkspaceChanged()
      return result
    },
    async stageSessionChanges(sessionId, input) {
      const result = await requestJson<UiChangeMutationResult>(`/api/sessions/${encodeURIComponent(sessionId)}/changes/stage`, {
        method: "POST",
        body: JSON.stringify(input),
      })
      notifyWorkspaceChanged()
      return result
    },
    async unstageSessionChanges(sessionId, input) {
      const result = await requestJson<UiChangeMutationResult>(`/api/sessions/${encodeURIComponent(sessionId)}/changes/unstage`, {
        method: "POST",
        body: JSON.stringify(input),
      })
      notifyWorkspaceChanged()
      return result
    },
    async commitSessionChanges(sessionId, input) {
      const result = await requestJson<UiChangeMutationResult>(`/api/sessions/${encodeURIComponent(sessionId)}/changes/commit`, {
        method: "POST",
        body: JSON.stringify(input),
      })
      notifyWorkspaceChanged()
      return result
    },
    sessionValidations: (sessionId) => requestJson<{ validations: UiValidationRecord[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/validations`,
    ),
    async runSessionValidation(sessionId, input) {
      const result = await requestJson<{ record: UiValidationRecord; validations: UiValidationRecord[]; currentRevision: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/validations`,
        { method: "POST", body: JSON.stringify(input) },
      )
      notifyWorkspaceChanged()
      return result
    },
    rollbackTurn: (sessionId, turnId) => requestJson<{ turnId: string; checkpointId: string; changes: UiChangeSetSnapshot }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/rollback`,
      { method: "POST", body: "{}" },
    ),
    listFiles: (sessionId) => requestJson<{ files: UiFileSummary[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/files`),
    previewFile: (sessionId, path) =>
      requestJson<{ path: string; size: number; updatedAt: string; content: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(path)}`,
      ),
    async uploadFiles(sessionId, files) {
      const form = new FormData()
      for (const file of Array.from(files)) form.append("files", file)
      const response = await fetchImpl(withTokenQuery(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      })
      const body = (await response.json()) as ApiResponse<{ files: UiFileSummary[] }>
      if (!body.ok) throw new Error(body.message)
      return body.data
    },
    listSkills: () => requestJson<{ skills: UiSkillSummary[] }>("/api/skills"),
    listMcp: () => requestJson<{ servers: UiMcpServerSummary[] }>("/api/mcp"),
    startRun: (input) =>
      requestJson<{ runId: string; turnId: string; status: RunStatus }>("/api/runs", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    getRunStatus: (runId) =>
      requestJson<{ found: boolean; status?: RunStatus }>(`/api/runs/${encodeURIComponent(runId)}`),
    cancelRun: (runId) =>
      requestJson<{ runId: string; status: RunStatus }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: "{}",
      }),
    answerPermission: (id, input) =>
      requestJson<{ id: string; action: string }>(`/api/permissions/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    listDir: (path) =>
      requestJson<UiFsListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
    eventSource(runId) {
      return new EventSource(withTokenQuery(`/api/runs/${encodeURIComponent(runId)}/events`))
    },
  }
}

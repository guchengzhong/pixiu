import type {
  ApiResponse,
  RunStatus,
  UiConfigResponse,
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
} from "../shared/api"

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
  listFiles(sessionId: string): Promise<{ files: UiFileSummary[] }>
  previewFile(sessionId: string, path: string): Promise<{ path: string; size: number; updatedAt: string; content: string }>
  uploadFiles(sessionId: string, files: FileList | File[]): Promise<{ files: UiFileSummary[] }>
  listSkills(): Promise<{ skills: UiSkillSummary[] }>
  listMcp(): Promise<{ servers: UiMcpServerSummary[] }>
  startRun(input: { message: string; sessionId?: string; permissionMode: string }): Promise<{ runId: string; status: RunStatus }>
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
    createProject: (input) =>
      requestJson<{ project: UiProjectSummary }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    updateProject: (projectId, input) =>
      requestJson<{ project: UiProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    selectProject: (projectId) =>
      requestJson<{ project: UiProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}/select`, {
        method: "POST",
        body: "{}",
      }),
    removeProjectEntry: (projectId) =>
      requestJson<{ project: UiProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        body: "{}",
      }),
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
      requestJson<{ runId: string; status: RunStatus }>("/api/runs", {
        method: "POST",
        body: JSON.stringify(input),
      }),
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

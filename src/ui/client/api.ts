import type {
  ApiResponse,
  UiConfigResponse,
  UiFileSummary,
  UiProviderSummary,
  UiRunResult,
  UiSessionDetail,
  UiSessionSummary,
  UiStatus,
} from "../shared/api"

export type UiApiClient = {
  status(): Promise<UiStatus>
  config(): Promise<UiConfigResponse>
  saveProvider(input: ProviderConfigPayload): Promise<{ provider: UiProviderSummary }>
  testProvider(): Promise<{ ok: true; model: string; text: string }>
  listSessions(): Promise<{ sessions: UiSessionSummary[] }>
  createSession(input: { title?: string }): Promise<{ session: UiSessionSummary; files: UiFileSummary[] }>
  getSession(sessionId: string): Promise<UiSessionDetail>
  listFiles(sessionId: string): Promise<{ files: UiFileSummary[] }>
  previewFile(sessionId: string, path: string): Promise<{ path: string; size: number; updatedAt: string; content: string }>
  uploadFiles(sessionId: string, files: FileList | File[]): Promise<{ files: UiFileSummary[] }>
  startRun(input: { message: string; sessionId?: string; permissionMode: string }): Promise<{ runId: string; status: string }>
  cancelRun(runId: string): Promise<{ runId: string; status: string }>
  answerPermission(id: string, input: { action: "allow" | "deny"; scope: "once" | "sessionSimilar" }): Promise<{ id: string; action: string }>
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

export function createUiApiClient(token: string, fetchImpl: UiFetch = fetch): UiApiClient {
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
    listSessions: () => requestJson<{ sessions: UiSessionSummary[] }>("/api/sessions"),
    createSession: (input) =>
      requestJson<{ session: UiSessionSummary; files: UiFileSummary[] }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    getSession: (sessionId) => requestJson<UiSessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`),
    listFiles: (sessionId) => requestJson<{ files: UiFileSummary[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/files`),
    previewFile: (sessionId, path) =>
      requestJson<{ path: string; size: number; updatedAt: string; content: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(path)}`,
      ),
    async uploadFiles(sessionId, files) {
      const form = new FormData()
      for (const file of Array.from(files)) form.append("files", file)
      const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      })
      const body = (await response.json()) as ApiResponse<{ files: UiFileSummary[] }>
      if (!body.ok) throw new Error(body.message)
      return body.data
    },
    startRun: (input) =>
      requestJson<{ runId: string; status: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    cancelRun: (runId) =>
      requestJson<{ runId: string; status: string }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: "{}",
      }),
    answerPermission: (id, input) =>
      requestJson<{ id: string; action: string }>(`/api/permissions/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    eventSource(runId) {
      return new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?token=${encodeURIComponent(token)}`)
    },
  }
}

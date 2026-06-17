import type { StatusSummary } from "../types"

export function StatusPanel({ status }: { status: StatusSummary | undefined }) {
  return (
    <div className="tab-panel active">
      <div className="trace-item"><strong>Run status</strong><pre>{status?.runStatusLabel ?? "Ready"}</pre></div>
      <div className="trace-item"><strong>Provider key</strong><pre>{status?.providerKeyPresent ? "ready" : "missing"}</pre></div>
      <div className="trace-item"><strong>Project</strong><pre>{status?.cwd ?? "loading"}</pre></div>
      <div className="trace-item"><strong>Workspace</strong><pre>{status?.workspace ?? "loading"}</pre></div>
      <div className="trace-item"><strong>Session store</strong><pre>{status?.sessionsPath ?? "loading"}</pre></div>
      <div className="trace-item"><strong>Diagnostics</strong><pre>{`skills: ${status?.skills ?? 0}\nmcp configured: ${status?.mcp?.configured ?? 0}\nmcp connected: ${status?.mcp?.connected ?? 0}\nmcp failed: ${status?.mcp?.failed ?? 0}\nmcp disabled: ${status?.mcp?.disabled ?? 0}`}</pre></div>
    </div>
  )
}

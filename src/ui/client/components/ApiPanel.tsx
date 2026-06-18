import type { StatusSummary } from "../types"

export function ApiPanel({ status }: { status: StatusSummary | undefined }) {
  return (
    <div className="tab-panel active">
      <div className="trace-item">
        <strong>API readiness</strong>
        <pre>{status?.providerKeyPresent ? "ready" : "missing key"}</pre>
      </div>
      <div className="trace-item">
        <strong>Run status</strong>
        <pre>{status?.runStatusLabel ?? "Ready"}</pre>
      </div>
      <div className="trace-item">
        <strong>Workspace</strong>
        <pre>{status?.workspace ?? "loading"}</pre>
      </div>
    </div>
  )
}

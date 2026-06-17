import { activityStatusMarker } from "../../../activity/format"
import { groupActivityForDisplay } from "../activity"
import { redactUiText } from "../redact"
import type { ActivityItem } from "../types"

export function SemanticActivityList({ activity }: { activity: ActivityItem[] }) {
  const groups = groupActivityForDisplay(activity)
  const primaryItems = groups.primary.length ? groups.primary : groups.secondary
  const secondaryItems = groups.primary.length ? groups.secondary : []
  return (
    <section className="semantic-activity" aria-label="Semantic Activity">
      <div className="timeline-section-head">
        <span>Activity</span>
        <strong>{groups.primary.length || activity.length}</strong>
      </div>
      {!primaryItems.length ? (
        <div className="empty-panel">No semantic activity yet. Raw tool events remain available below.</div>
      ) : (
        <div className="semantic-activity-list">
          {primaryItems.map((item) => <ActivityRow item={item} key={item.id} />)}
          {secondaryItems.length ? (
            <details className="activity-detail-group">
              <summary>Run details <span>{secondaryItems.length}</span></summary>
              <div className="semantic-activity-list compact">
                {secondaryItems.map((item) => <ActivityRow item={item} key={item.id} secondary />)}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </section>
  )
}

function ActivityRow({ item, secondary = false }: { item: ActivityItem; secondary?: boolean }) {
  return (
    <details className={`semantic-activity-item semantic-activity-${item.status} ${secondary ? "semantic-activity-secondary" : ""}`} key={item.id}>
      <summary className="semantic-activity-summary">
        <span className="timeline-marker" aria-hidden="true">{activityStatusMarker(item.status)}</span>
        <span className="timeline-copy">
          <span className="timeline-title">{item.title}</span>
          {item.summary || item.target || item.command ? (
            <span className="timeline-subtitle">{item.summary ?? item.target ?? item.command}</span>
          ) : null}
        </span>
      </summary>
      <div className="timeline-raw-details">
        <div className="timeline-raw-item">
          <div className="timeline-raw-title">
            <span>{item.kind}</span>
            <span className="trace-kind">{item.status}</span>
          </div>
          <pre>{redactUiText(activityDetails(item))}</pre>
        </div>
      </div>
    </details>
  )
}

function activityDetails(item: ActivityItem) {
  return JSON.stringify({
    ...(item.target ? { target: item.target } : {}),
    ...(item.command ? { command: item.command } : {}),
    ...(item.toolName ? { toolName: item.toolName } : {}),
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.endedAt ? { endedAt: item.endedAt } : {}),
    ...(item.details ? { details: item.details } : {}),
    ...(item.rawEventIds ? { rawEventIds: item.rawEventIds } : {}),
    ...(item.source ? { source: item.source } : {}),
  }, null, 2)
}

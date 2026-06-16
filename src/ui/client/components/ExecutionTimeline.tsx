import { deriveExecutionTimeline, timelineStatusMarker } from "../timeline"
import { redactUiText } from "../redact"
import type { TraceItem } from "../types"

export function ExecutionTimeline({ trace }: { trace: TraceItem[] }) {
  const timeline = deriveExecutionTimeline(trace)
  return (
    <section className="execution-timeline" aria-label="Execution Timeline">
      <div className="timeline-section-head">
        <span>Execution Timeline</span>
        <strong>{timeline.length}</strong>
      </div>
      {!timeline.length ? (
        <div className="empty-panel">No execution activity yet. Tool calls and run events will appear here.</div>
      ) : (
        <div className="timeline-list">
          {timeline.map((item) => (
            <details className={`timeline-item timeline-item-${item.status}`} key={item.id}>
              <summary className="timeline-summary">
                <span className="timeline-marker" aria-hidden="true">{timelineStatusMarker(item.status)}</span>
                <span className="timeline-copy">
                  <span className="timeline-title">{item.title}</span>
                  {item.subtitle ? <span className="timeline-subtitle">{item.subtitle}</span> : null}
                </span>
              </summary>
              <div className="timeline-raw-details">
                {item.raw.map((raw) => (
                  <div className="timeline-raw-item" key={raw.id}>
                    <div className="timeline-raw-title">
                      <span>{raw.title}</span>
                      {raw.kind ? <span className="trace-kind">{raw.kind}</span> : null}
                    </div>
                    {raw.detail ? <pre>{redactUiText(raw.detail)}</pre> : null}
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}

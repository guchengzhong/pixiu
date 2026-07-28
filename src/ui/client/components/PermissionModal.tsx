import { ShieldAlert } from "lucide-react"
import { useEffect, useRef, type KeyboardEvent } from "react"

import { redactUiText } from "../redact"
import type { PermissionView } from "../types"

export function PermissionModal({ permission, answer }: { permission: PermissionView | undefined; answer(action: "allow" | "deny", scope: "once" | "sessionSimilar"): void }) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!permission) return
    const previousFocus = document.activeElement
    const panel = panelRef.current
    panel?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [permission?.id])

  useEffect(() => {
    if (permission?.submitting) panelRef.current?.focus()
  }, [permission?.id, permission?.submitting])

  if (!permission) return null

  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return
    const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
    if (!buttons.length) {
      event.preventDefault()
      panelRef.current?.focus()
      return
    }
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="config open permission-overlay">
      <div
        className="config-panel permission-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <div className="config-head">
          <div className="permission-title">
            <ShieldAlert aria-hidden="true" />
            <strong id="permission-title">Permission required</strong>
          </div>
          <span className="status-badge status-warning">{permission.request.risk ?? "review"}</span>
        </div>
        <div className="config-body">
          <div className="notice">{permission.decision.reason ?? ""}</div>
          {permission.request.cwd ? <div className="permission-context"><span>Working directory</span><code>{permission.request.cwd}</code></div> : null}
          <div className="preview">
            <strong>{permission.request.tool ?? "tool"}</strong>
            <pre>{redactUiText(JSON.stringify(permission.request.input ?? {}, null, 2))}</pre>
          </div>
          {permission.error ? <div className="notice error" role="alert">{permission.error}</div> : null}
          <div className="form-actions">
            <button className="danger" type="button" disabled={permission.submitting} onClick={() => answer("deny", "once")}>Deny</button>
            <button className="ghost" type="button" disabled={permission.submitting} onClick={() => answer("allow", "sessionSimilar")}>Allow similar</button>
            <button className="primary" type="button" disabled={permission.submitting} onClick={() => answer("allow", "once")}>{permission.submitting ? "Applying..." : "Allow once"}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

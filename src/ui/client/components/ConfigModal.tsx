import { useEffect, useRef, type KeyboardEvent } from "react"

import type { ProviderConfigPayload } from "../api"
import type { UiProjectSummary } from "../../shared/api"
import { ENDPOINTS } from "../constants"

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

export function ConfigModal(props: {
  open: boolean
  onboarding: boolean
  close(): void
  notice: { text: string; kind?: "ok" | "error" }
  form: ProviderConfigPayload
  setForm(updater: (form: ProviderConfigPayload) => ProviderConfigPayload): void
  endpointPreset: keyof typeof ENDPOINTS | "custom"
  setEndpointPreset(value: keyof typeof ENDPOINTS | "custom"): void
  save(): void
  test(): void
  projects: UiProjectSummary[]
  currentProjectId: string | undefined
  selectProject(projectId: string): void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const initialFocusRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    if (!props.open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    initialFocusRef.current?.focus()
    return () => previouslyFocused?.focus()
  }, [props.open])

  if (!props.open) return null
  const update = (patch: Partial<ProviderConfigPayload>) => props.setForm((current) => ({ ...current, ...patch }))

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (!props.onboarding) props.close()
      return
    }
    if (event.key !== "Tab") return

    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return

    if (!panelRef.current?.contains(document.activeElement)) {
      event.preventDefault()
      const target = event.shiftKey ? last : first
      target.focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="config open">
      <div
        className="config-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="config-head">
          <strong id="config-title">{props.onboarding ? "Set up Pixiu" : "Provider configuration"}</strong>
          {!props.onboarding ? <button className="ghost" type="button" onClick={props.close}>Close</button> : null}
        </div>
        <form className="config-body" onSubmit={(event) => { event.preventDefault(); props.onboarding ? props.test() : props.save() }}>
          {props.onboarding ? (
            <div className="field">
              <label htmlFor="setupProject">Project workspace</label>
              <select id="setupProject" value={props.currentProjectId ?? ""} onChange={(event) => props.selectProject(event.currentTarget.value)}>
                <option value="" disabled>Select a project</option>
                {props.projects.map((project) => <option value={project.id} key={project.id}>{project.name} - {project.rootPath}</option>)}
              </select>
            </div>
          ) : null}
          <div className="config-grid">
            <div className="field">
              <label htmlFor="endpointPreset">Endpoint</label>
              <select
                id="endpointPreset"
                ref={initialFocusRef}
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
          <div className={`notice ${props.notice.kind ?? ""}`} role={props.notice.kind === "error" ? "alert" : "status"}>{props.notice.text}</div>
          <div className="form-actions">
            {props.onboarding ? (
              <button className="primary" type="button" disabled={!props.currentProjectId} onClick={props.test}>Save and test connection</button>
            ) : (
              <>
                <button className="ghost" type="button" onClick={props.test}>Save and test</button>
                <button className="primary" type="submit">Save provider</button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

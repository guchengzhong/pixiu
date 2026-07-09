import { useEffect, useState } from "react"

import type { UiFsListing } from "../shared/api"

export function FolderPicker(props: {
  listDir(path?: string): Promise<UiFsListing>
  onSelect(path: string): void
  onClose(): void
}) {
  const [listing, setListing] = useState<UiFsListing>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [manual, setManual] = useState("")

  async function load(path?: string) {
    setLoading(true)
    setError(undefined)
    try {
      const next = await props.listDir(path)
      setListing(next)
      setManual(next.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="config open">
      <div className="config-panel folder-picker">
        <div className="config-head">
          <strong>Select a folder</strong>
          <button className="ghost" type="button" onClick={props.onClose}>Close</button>
        </div>
        <div className="folder-picker-body">
          <div className="folder-picker-toolbar">
            <button
              className="ghost"
              type="button"
              disabled={!listing?.parent}
              onClick={() => listing?.parent && void load(listing.parent)}
            >
              ↑ Up
            </button>
            <input
              value={manual}
              placeholder="Absolute path"
              onChange={(event) => setManual(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void load(manual) } }}
            />
            <button className="ghost" type="button" onClick={() => void load(manual)}>Go</button>
          </div>

          {listing?.drives?.length ? (
            <div className="folder-picker-drives">
              {listing.drives.map((drive) => (
                <button key={drive} className="ghost" type="button" onClick={() => void load(drive)}>{drive}</button>
              ))}
            </div>
          ) : null}

          <div className="folder-picker-current" title={listing?.path}>{listing?.path ?? "…"}</div>

          <div className="folder-picker-list">
            {loading ? (
              <div className="folder-picker-empty">Loading…</div>
            ) : error ? (
              <div className="folder-picker-empty error">{error}</div>
            ) : !listing?.entries.length ? (
              <div className="folder-picker-empty">No subfolders</div>
            ) : (
              listing.entries.map((entry) => (
                <button key={entry.path} className="folder-picker-item" type="button" onDoubleClick={() => void load(entry.path)} onClick={() => void load(entry.path)}>
                  <span className="folder-picker-icon">📁</span>
                  <span className="folder-picker-name">{entry.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="form-actions">
          <button className="ghost" type="button" onClick={props.onClose}>Cancel</button>
          <button className="primary" type="button" disabled={!listing?.path} onClick={() => listing?.path && props.onSelect(listing.path)}>
            Use this folder
          </button>
        </div>
      </div>
    </div>
  )
}

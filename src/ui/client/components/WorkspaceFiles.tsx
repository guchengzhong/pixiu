import type { SessionEvidence } from "../../../session/evidence"
import type { UiFileSummary } from "../../shared/api"
import { fileNameFromPath, formatSize } from "../helpers"
import { redactUiText } from "../redact"
import type { FilePreview, FileReferenceSource } from "../types"

type FileCategory = {
  key: FileReferenceSource
  title: string
  description: string
  empty: string
  files: UiFileSummary[]
}

type EvidenceItem = {
  title: string
  meta: string
  kind: "artifact" | "source" | "command"
}

export function WorkspaceFiles(props: {
  files: UiFileSummary[]
  preview: FilePreview | undefined
  evidence: SessionEvidence | undefined
  onPreview(file: UiFileSummary): void
  onReference(file: UiFileSummary, source: FileReferenceSource): void
}) {
  const artifactPaths = new Set(props.evidence?.artifacts.map((item) => item.path) ?? [])
  const categories: FileCategory[] = [
    {
      key: "uploaded",
      title: "Uploaded",
      description: "Files added to this session through the composer.",
      empty: "No uploaded files in this session.",
      files: props.files.filter((file) => file.path.startsWith("uploads/")),
    },
    {
      key: "workspace",
      title: "Workspace",
      description: "Files currently visible from the session workspace.",
      empty: "No workspace files are visible yet.",
      files: props.files.filter((file) => !file.path.startsWith("uploads/") && !artifactPaths.has(file.path)),
    },
    {
      key: "generated",
      title: "Generated / Artifacts",
      description: "Files produced by agent write, edit, or patch activity.",
      empty: "No generated artifacts yet.",
      files: props.files.filter((file) => artifactPaths.has(file.path)),
    },
  ]
  const evidenceItems: EvidenceItem[] = [
    ...(props.evidence?.artifacts.map((item) => ({ title: item.path, meta: `artifact via ${item.tool}`, kind: "artifact" as const })) ?? []),
    ...(props.evidence?.sources.map((item) => ({ title: item.title ?? item.url ?? item.query ?? "source", meta: item.tool, kind: "source" as const })) ?? []),
    ...(props.evidence?.shellCommands.map((item) => ({
      title: item.command,
      meta: `command evidence${item.exitCode === undefined ? "" : ` · exit ${item.exitCode}`}`,
      kind: "command" as const,
    })) ?? []),
  ]

  return (
    <div className="tab-panel active">
      {categories.map((category) => (
        <section className="file-category" key={category.key}>
          <div className="file-category-head">
            <div className="file-category-copy">
              <div className="file-category-title">
                <strong>{category.title}</strong>
                <span className="file-count">{category.files.length}</span>
              </div>
              <p>{category.description}</p>
            </div>
          </div>
          {category.files.length ? (
            category.files.slice(0, 40).map((file) => (
              <div className="file-row" key={`${category.key}:${file.path}`}>
                <button className="file-item" type="button" onClick={() => props.onPreview(file)}>
                  <span className="file-name">{fileNameFromPath(file.path)}</span>
                  <span className="file-path" title={file.path}>{file.path}</span>
                  <span className="file-badges">
                    <span className="file-badge">{category.title}</span>
                    <span className="file-badge">{file.kind}</span>
                    <span className="file-badge muted">{formatSize(file.size)}</span>
                  </span>
                </button>
                <div className="file-actions">
                  <button className="file-action primary-action" type="button" onClick={() => props.onPreview(file)}>Preview</button>
                  <button className="file-action" type="button" onClick={() => props.onReference(file, category.key)}>Reference</button>
                  <button className="file-action subtle-action" type="button" onClick={() => void navigator.clipboard?.writeText(file.path)}>Copy</button>
                </div>
              </div>
            ))
          ) : (
            <div className="file-empty-state">{category.empty}</div>
          )}
        </section>
      ))}
      <section className="file-category">
        <div className="file-category-head">
          <div className="file-category-copy">
            <div className="file-category-title">
              <strong>Evidence</strong>
              <span className="file-count">{evidenceItems.length}</span>
            </div>
            <p>Artifacts, web sources, and shell command evidence collected from runs.</p>
          </div>
        </div>
        {evidenceItems.length ? (
          evidenceItems.slice(0, 20).map((item, index) => (
            <div className={`evidence-file-row evidence-${item.kind}`} key={`${item.title}_${index}`}>
              <span className="evidence-kind">{item.kind === "command" ? "Command evidence" : item.kind}</span>
              <span className="file-name">{item.title}</span>
              <span className="file-meta">{item.meta}</span>
            </div>
          ))
        ) : (
          <div className="file-empty-state">No evidence files or sources yet.</div>
        )}
      </section>
      {props.preview ? (
        <div className={`preview file-preview-card ${props.preview.status !== "ready" ? "preview-unsupported" : ""}`}>
          <div className="preview-head">
            <strong>{props.preview.status === "ready" ? "Preview" : "Preview unavailable"}</strong>
            <span title={props.preview.path}>{props.preview.path}</span>
          </div>
          {props.preview.status === "ready" ? (
            <pre>{redactUiText(props.preview.content ?? "")}</pre>
          ) : (
            <p>{props.preview.message ?? "Preview is not available for this file type yet."}</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

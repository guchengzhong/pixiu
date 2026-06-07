import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"

import { MinicodeError } from "../shared/errors"
import type {
  RemoteSkillDetail,
  RemoteSkillSummary,
  SkillInstallFilePlan,
  SkillInstallManifest,
  SkillInstallPlan,
  SkillInstallResult,
} from "./types"

export class SkillHubProvider {
  constructor(private readonly options: { baseURL: string; apiKey?: string }) {}

  private headers() {
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" }
    if (this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`
      headers["x-api-key"] = this.options.apiKey
    }
    return headers
  }

  async search(query: string, limit = 10): Promise<RemoteSkillSummary[]> {
    const url = `${this.options.baseURL.replace(/\/$/, "")}/api/v1/skills/search`
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, limit, method: "hybrid" }),
    })
    if (!response.ok) throw new MinicodeError(`SkillHub search failed (${response.status})`, { code: "SKILLHUB_SEARCH_FAILED" })
    const json: any = await response.json()
    const rows = Array.isArray(json) ? json : json.skills ?? json.results ?? []
    return rows.slice(0, limit).map((item: any, index: number) => {
      const summary: RemoteSkillSummary = {
        id: String(item.id ?? item.name ?? index),
        name: String(item.name ?? item.title ?? item.id ?? `skill-${index}`),
        description: String(item.description ?? item.summary ?? ""),
        source: String(item.source ?? item.url ?? this.options.baseURL),
      }
      if (item.version) summary.version = String(item.version)
      if (item.updatedAt ?? item.updated_at) summary.updatedAt = item.updatedAt ?? item.updated_at
      return summary
    })
  }

  async detail(id: string): Promise<RemoteSkillDetail> {
    const url = `${this.options.baseURL.replace(/\/$/, "")}/api/v1/skills/${encodeURIComponent(id)}`
    const response = await fetch(url, { headers: this.headers() })
    if (!response.ok) throw new MinicodeError(`SkillHub detail failed (${response.status})`, { code: "SKILLHUB_DETAIL_FAILED" })
    const item: any = await response.json()
    const name = String(item.name ?? item.title ?? id)
    const detail: RemoteSkillDetail = {
      id: String(item.id ?? id),
      name,
      description: String(item.description ?? item.summary ?? ""),
      source: String(item.source ?? item.url ?? this.options.baseURL),
    }
    if (item.version) detail.version = String(item.version)
    if (item.updatedAt ?? item.updated_at) detail.updatedAt = item.updatedAt ?? item.updated_at
    if (item.content ?? item.skill_md ?? item.skillMd) detail.content = item.content ?? item.skill_md ?? item.skillMd
    if (Array.isArray(item.files)) detail.files = item.files
    return detail
  }
}

export function planSkillInstall(skill: RemoteSkillDetail, installRoot: string): SkillInstallPlan {
  const targetDir = resolve(installRoot, safeSkillDirName(skill.name))
  const files = materializeSkillFiles(skill).map((file) => filePlan(file.path, file.content))
  return {
    skill: remoteSummary(skill),
    targetDir,
    files: [...files, { path: ".source.json", bytes: 0, sha256: "computed-at-install" }],
    warning: [
      `Install remote skill "${skill.name}" from ${skill.source} into ${targetDir}.`,
      `Files: ${files.map((file) => file.path).join(", ") || "(none)"}, .source.json`,
      "Review SKILL.md before trusting it.",
    ].join("\n"),
  }
}

export async function installRemoteSkill(
  skill: RemoteSkillDetail,
  installRoot: string,
  options: { installedAt?: string } = {},
): Promise<SkillInstallResult> {
  const plan = planSkillInstall(skill, installRoot)
  const files = materializeSkillFiles(skill)
  await mkdir(plan.targetDir, { recursive: true })
  for (const file of files) {
    const path = join(plan.targetDir, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.content, "utf8")
  }
  const manifest = installManifest({
    skill,
    targetDir: plan.targetDir,
    files: files.map((file) => filePlan(file.path, file.content)),
    installedAt: options.installedAt ?? new Date().toISOString(),
  })
  const manifestContent = JSON.stringify(manifest, null, 2)
  const manifestPath = join(plan.targetDir, ".source.json")
  await writeFile(manifestPath, `${manifestContent}\n`, "utf8")
  return {
    ...plan,
    files: [...manifest.files, filePlan(".source.json", `${manifestContent}\n`)],
    manifestPath,
    manifest,
  }
}

function materializeSkillFiles(skill: RemoteSkillDetail) {
  const files =
    skill.files?.map((file) => ({ path: normalizeRemoteFilePath(file.path), content: file.content })) ??
    ([] as Array<{ path: string; content: string }>)
  if (!files.some((file) => file.path === "SKILL.md")) {
    files.unshift({
      path: "SKILL.md",
      content:
        skill.content ??
        [`---`, `name: ${skill.name}`, `description: ${skill.description}`, `---`, "", `# ${skill.name}`, "", skill.description].join("\n"),
    })
  }
  return files
}

function normalizeRemoteFilePath(path: string) {
  const normalized = path.replaceAll("\\", "/").trim()
  const parts = normalized.split("/")
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new MinicodeError(`Invalid remote skill file path: ${path}`, { code: "SKILLHUB_FILE_PATH_INVALID" })
  }
  return parts.join("/")
}

function safeSkillDirName(name: string) {
  const safe = basename(name)
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^\.+/, "")
    .replace(/-+/g, "-")
  return safe || "skill"
}

function sha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function filePlan(path: string, content: string): SkillInstallFilePlan {
  return {
    path,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
  }
}

function remoteSummary(skill: RemoteSkillSummary): RemoteSkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    ...(skill.version ? { version: skill.version } : {}),
    ...(skill.updatedAt ? { updatedAt: skill.updatedAt } : {}),
  }
}

function installManifest(input: {
  skill: RemoteSkillSummary
  targetDir: string
  files: SkillInstallFilePlan[]
  installedAt: string
}): SkillInstallManifest {
  return {
    schemaVersion: 1,
    installer: "minicode",
    installedAt: input.installedAt,
    remote: remoteSummary(input.skill),
    targetDir: input.targetDir,
    files: input.files,
  }
}

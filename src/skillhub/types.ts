export type RemoteSkillSummary = {
  id: string
  name: string
  description: string
  source: string
  version?: string
  updatedAt?: string
}

export type RemoteSkillDetail = RemoteSkillSummary & {
  content?: string
  files?: Array<{ path: string; content: string }>
}

export type SkillInstallFilePlan = {
  path: string
  bytes: number
  sha256: string
}

export type SkillInstallManifest = {
  schemaVersion: 1
  installer: "minicode"
  installedAt: string
  remote: RemoteSkillSummary
  targetDir: string
  files: SkillInstallFilePlan[]
}

export type SkillInstallPlan = {
  skill: RemoteSkillSummary
  targetDir: string
  files: SkillInstallFilePlan[]
  warning: string
}

export type SkillInstallResult = SkillInstallPlan & {
  manifestPath: string
  manifest: SkillInstallManifest
}

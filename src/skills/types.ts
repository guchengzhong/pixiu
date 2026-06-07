export type SkillSource = {
  root: string
  rootIndex: number
  relativePath: string
}

export type SkillFile = {
  path: string
  size: number
}

export type SkillDuplicate = {
  rootDir: string
  skillPath: string
  source: SkillSource
}

export type SkillDiagnostic = {
  code: "SKILL_INVALID" | "SKILL_DUPLICATE" | "SKILL_SCAN_FAILED"
  message: string
  root?: string
  skillPath?: string
}

export type SkillSummary = {
  name: string
  description: string
  rootDir: string
  skillPath: string
  source: SkillSource
  duplicates?: SkillDuplicate[]
}

export type LoadedSkill = SkillSummary & {
  content: string
  files: SkillFile[]
}

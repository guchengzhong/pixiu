import { access, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { homedir } from "node:os"

import { MinicodeError } from "../shared/errors"
import { isInside } from "../sandbox/path"
import type { LoadedSkill, SkillDiagnostic, SkillDuplicate, SkillFile, SkillSource, SkillSummary } from "./types"

function expandHome(path: string) {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path)
}

function splitFrontmatter(content: string) {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return { metadata: {}, body: content }
  return {
    metadata: parseFrontmatter(match[1] ?? ""),
    body: content.slice(match[0].length),
  }
}

function parseFrontmatter(input: string) {
  const metadata: Record<string, string> = {}
  const lines = input.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const raw = (match[2] ?? "").trim()
    if (/^[>|]/.test(raw)) {
      const block: string[] = []
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? ""
        if (/^[A-Za-z0-9_-]+:\s*/.test(next)) break
        index += 1
        block.push(next.replace(/^[ \t]{1,4}/, ""))
      }
      metadata[key] = raw.startsWith(">") ? block.map((item) => item.trim()).filter(Boolean).join(" ") : block.join("\n").trim()
    } else {
      metadata[key] = unquote(raw)
    }
  }
  return metadata
}

function unquote(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseMetadata(content: string, skillPath: string) {
  const { metadata, body } = splitFrontmatter(content)
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const description =
    metadata.description ??
    body
      .split(/\r?\n/)
      .find((line) => line.trim() && !line.startsWith("#"))
      ?.trim()
  const name = metadata.name ?? heading
  if (!name || !description) {
    throw new MinicodeError(`Skill ${skillPath} must include name and description`, { code: "SKILL_INVALID" })
  }
  return { name: name.trim(), description: description.trim() }
}

function skillSource(root: string, rootIndex: number, skillPath: string): SkillSource {
  return {
    root,
    rootIndex,
    relativePath: toRelativePath(root, skillPath),
  }
}

function toRelativePath(root: string, path: string) {
  return relative(root, path).replaceAll("\\", "/")
}

function duplicateOf(skill: SkillSummary): SkillDuplicate {
  return {
    rootDir: skill.rootDir,
    skillPath: skill.skillPath,
    source: skill.source,
  }
}

export class SkillLoader {
  constructor(private readonly paths: string[]) {}

  private async discover() {
    const diagnostics: SkillDiagnostic[] = []
    const skills = new Map<string, SkillSummary>()
    const roots = this.paths.map(expandHome)
    for (const [rootIndex, root] of roots.entries()) {
      try {
        await access(root)
      } catch {
        continue
      }

      let matches: string[] = []
      try {
        for await (const skillPath of new Bun.Glob("**/SKILL.md").scan({ cwd: root, absolute: true, onlyFiles: true })) {
          matches.push(skillPath)
        }
      } catch (cause) {
        diagnostics.push({
          code: "SKILL_SCAN_FAILED",
          root,
          message: `Failed to scan skills under ${root}: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
        continue
      }

      for (const skillPath of matches.sort((a, b) => a.localeCompare(b))) {
        let metadata: Pick<SkillSummary, "name" | "description">
        try {
          metadata = parseMetadata(await readFile(skillPath, "utf8"), skillPath)
        } catch (cause) {
          diagnostics.push({
            code: "SKILL_INVALID",
            root,
            skillPath,
            message: cause instanceof Error ? cause.message : String(cause),
          })
          continue
        }

        const summary: SkillSummary = {
          ...metadata,
          rootDir: dirname(skillPath),
          skillPath,
          source: skillSource(root, rootIndex, skillPath),
        }
        const existing = skills.get(summary.name)
        if (existing) {
          existing.duplicates = [...(existing.duplicates ?? []), duplicateOf(summary)]
          diagnostics.push({
            code: "SKILL_DUPLICATE",
            root,
            skillPath,
            message: `Duplicate skill "${summary.name}" ignored at ${skillPath}; using ${existing.skillPath}`,
          })
          continue
        }
        skills.set(summary.name, summary)
      }
    }
    return {
      skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
      diagnostics,
    }
  }

  async list() {
    return (await this.discover()).skills
  }

  async diagnostics() {
    return (await this.discover()).diagnostics
  }

  async search(query: string) {
    const skills = await this.list()
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    if (!terms.length) return skills
    return skills.filter((skill) => {
      const haystack = [skill.name, skill.description, skill.source.relativePath].join("\n").toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }

  async load(name: string): Promise<LoadedSkill> {
    const skill = await this.find(name)
    return { ...skill, content: await readFile(skill.skillPath, "utf8"), files: await this.filesFor(skill) }
  }

  async files(name: string) {
    return this.filesFor(await this.find(name))
  }

  async readRelative(skillName: string, relativePath: string) {
    const skill = await this.find(skillName)
    const normalized = relativePath.trim()
    if (!normalized || normalized.includes("\0") || isAbsolute(normalized)) {
      throw new MinicodeError(`Skill path must be a relative file path: ${relativePath}`, { code: "SKILL_PATH_INVALID" })
    }
    const path = resolve(skill.rootDir, normalized)
    if (!isInside(skill.rootDir, path)) {
      throw new MinicodeError(`Skill path escapes root: ${relativePath}`, { code: "SKILL_PATH_ESCAPE" })
    }
    return readFile(path, "utf8")
  }

  private async find(name: string) {
    const skills = await this.list()
    const skill = skills.find((item) => item.name === name)
    if (!skill) {
      throw new MinicodeError(`Skill not found: ${name}. Available: ${skills.map((item) => item.name).join(", ")}`, {
        code: "SKILL_NOT_FOUND",
      })
    }
    return skill
  }

  private async filesFor(skill: SkillSummary, limit = 50): Promise<SkillFile[]> {
    const files: SkillFile[] = []
    for await (const path of new Bun.Glob("**/*").scan({ cwd: skill.rootDir, absolute: true, onlyFiles: true, dot: true })) {
      if (path === skill.skillPath) continue
      const item = await stat(path)
      files.push({ path: toRelativePath(skill.rootDir, path), size: item.size })
    }
    return files.sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit)
  }
}

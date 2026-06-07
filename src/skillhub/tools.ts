import { join } from "node:path"

import type { MinicodeConfig } from "../config/defaults"
import type { ToolDefinition } from "../tools/types"
import { SkillHubProvider, installRemoteSkill, planSkillInstall } from "./provider"

export function createSkillHubTools(skillhub: MinicodeConfig["skillhub"], cwd: string): ToolDefinition[] {
  const apiKey = skillhub.apiKeyEnv ? process.env[skillhub.apiKeyEnv] : undefined
  const provider = new SkillHubProvider({ baseURL: skillhub.baseURL, ...(apiKey ? { apiKey } : {}) })
  const installRoot = skillhub.installDir.startsWith("/") ? skillhub.installDir : join(cwd, skillhub.installDir)

  return [
    {
      name: "skillhub_search",
      description: "Search remote SkillHub skills on demand.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
      async execute(input) {
        const query = typeof input.query === "string" ? input.query : ""
        const limit = typeof input.limit === "number" ? input.limit : 10
        const skills = await provider.search(query, limit)
        return {
          ok: true,
          content: skills.map((skill) => `${skill.id}\t${skill.name}\t${skill.description}\t${skill.source}`).join("\n"),
          data: skills,
        }
      },
    },
    {
      name: "skillhub_install",
      description: "Install a remote SkillHub skill into the local skills directory.",
      risk: "high",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
      async execute(input) {
        const id = typeof input.id === "string" ? input.id : ""
        const detail = await provider.detail(id)
        const result = await installRemoteSkill(detail, installRoot)
        return {
          ok: true,
          content: [
            `Installed ${detail.name} to ${result.targetDir}`,
            `Manifest: ${result.manifestPath}`,
            "Files:",
            ...result.files.map((file) => `- ${file.path} (${file.bytes} bytes, sha256 ${file.sha256})`),
            planSkillInstall(detail, installRoot).warning,
          ].join("\n"),
          metadata: {
            targetDir: result.targetDir,
            manifestPath: result.manifestPath,
            source: detail.source,
            files: result.files.map((file) => file.path),
          },
        }
      },
    },
  ]
}

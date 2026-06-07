import type { ToolDefinition } from "../tools/types"
import type { SkillLoader } from "./loader"

export function createSkillTools(loader: SkillLoader): ToolDefinition[] {
  return [
    {
      name: "skill",
      description: "Load a local SKILL.md by name and return its instructions.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          path: { type: "string", description: "Optional skill-relative reference file path to load." },
        },
        required: ["name"],
      },
      async execute(input) {
        const name = typeof input.name === "string" ? input.name : ""
        const path = typeof input.path === "string" ? input.path.trim() : ""
        if (path) {
          const content = await loader.readRelative(name, path)
          const skill = await loader.load(name)
          return {
            ok: true,
            content,
            metadata: {
              name: skill.name,
              description: skill.description,
              rootDir: skill.rootDir,
              skillPath: skill.skillPath,
              path,
              source: skill.source,
              kind: "reference",
            },
          }
        }
        const skill = await loader.load(name)
        return {
          ok: true,
          content: renderSkillResult(skill),
          metadata: {
            name: skill.name,
            description: skill.description,
            rootDir: skill.rootDir,
            skillPath: skill.skillPath,
            source: skill.source,
            files: skill.files.map((file) => file.path),
            duplicates: skill.duplicates?.map((item) => item.skillPath) ?? [],
            kind: "main",
          },
        }
      },
    },
  ]
}

export async function renderSkillSystemPrompt(loader: SkillLoader) {
  const skills = await loader.list().catch(() => [])
  if (!skills.length) return ""
  return [
    "Available skills:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    "Use the skill tool to load the full SKILL.md only when needed. If the skill result lists reference files, call the skill tool again with { name, path } to load one safely.",
  ].join("\n")
}

function renderSkillResult(skill: Awaited<ReturnType<SkillLoader["load"]>>) {
  return [
    `Skill: ${skill.name}`,
    `Description: ${skill.description}`,
    skill.files.length
      ? ["Reference files available through the skill tool:", ...skill.files.map((file) => `- ${file.path} (${file.size} bytes)`)].join("\n")
      : "Reference files: none",
    "Instructions:",
    skill.content,
  ].join("\n\n")
}

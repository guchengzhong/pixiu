import type { ToolDefinition } from "../tools/types"
import type { SkillLoader } from "./loader"

// creates the skill tool definition that can be registered to the agent runner. The tool uses the skill loader
// to load the skill instructions and reference files when called by the agent.
export function createSkillTools(loader: SkillLoader): ToolDefinition[] { // return an array of tool definitions.
  // [{tool1}, {tool2}, ...]
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
          // content is the raw content of the reference file, and metadata includes the skill
          // and file information for agent's reference. The agent can call the skill tool again
          // with the { name, path } to load the content of the reference file when needed,
          // instead of loading all files at once through the system prompt, which may cause 
          // token overload and inefficient retrieval.
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
// render的中文意思是“渲染”，在这里指的是将技能信息和说明格式化成一个字符串，以便在系统提示中展示给代理使用。
// injects the injects skill names and descriptions into the system prompt for better agent decision making. 
// The agent can call the skill tool to load the full instructions when needed, and reference any files 
// listed in the skill result through the skill tool as well.
export async function renderSkillSystemPrompt(loader: SkillLoader) {
  const skills = await loader.list().catch(() => [])
  if (!skills.length) return ""
  return [
    "Available skills:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    "Use the skill tool to load the full SKILL.md only when needed. If the skill result lists reference files, call the skill tool again with { name, path } to load one safely.",
  ].join("\n")
}

// renders the skill result into a formatted string for display.
// Awaited<ReturnType<SkillLoader["load"]>> is the type of the resolved value of the promise returned by the load method of SkillLoader, 
// which is LoadedSkill. The function takes the loaded skill and formats its name, description, reference files, and instructions into 
// a readable string format for the agent to use in its system prompt or tool output.
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

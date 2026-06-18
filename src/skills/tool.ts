import type { ToolDefinition } from "../tools/types"
import type { SkillLoader } from "./loader"
import { logger } from "../runtime/logger"

const SKILL_PROMPT_LIST_LIMIT = 20

// creates the skill tool definition that can be registered to the agent runner. The tool uses the skill loader
// to load the skill instructions and reference files when called by the agent.
export function createSkillTools(loader: SkillLoader): ToolDefinition[] { // return an array of tool definitions.
  // [{tool1}, {tool2}, ...]
  return [
    {
      name: "skill_search",
      description: "Search installed local skills and return compact candidates before loading one.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Maximum number of skills to return." },
        },
        required: ["query"],
      },
      async execute(input) {
        const query = typeof input.query === "string" ? input.query : ""
        const limit = typeof input.limit === "number" ? input.limit : undefined
        const skills = await loader.search(query, limit === undefined ? {} : { limit })
        return {
          ok: true,
          content: skills.length ? skills.map(renderSkillSearchLine).join("\n") : "No matching local skills.",
          data: skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            ...(skill.contract ? { contract: skill.contract } : {}),
          })),
          metadata: {
            query,
            count: skills.length,
            skills: skills.map((skill) => skill.name),
            kind: "search",
            activity: {
              kind: "skill",
              title: "Searched skills",
              summary: `Searched skills for ${query}`,
              target: query,
              details: { count: skills.length },
            },
          },
        }
      },
    },
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
              ...(skill.contract ? { contract: skill.contract } : {}),
              rootDir: skill.rootDir,
              skillPath: skill.skillPath,
              path,
              source: skill.source,
              kind: "reference",
              activity: {
                kind: "skill",
                title: "Loaded skill reference",
                summary: `Loaded ${skill.name}/${path}`,
                target: `${skill.name}/${path}`,
              },
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
              ...(skill.contract ? { contract: skill.contract } : {}),
              rootDir: skill.rootDir,
              skillPath: skill.skillPath,
            source: skill.source,
            files: skill.files.map((file) => file.path),
            duplicates: skill.duplicates?.map((item) => item.skillPath) ?? [],
            kind: "main",
            activity: {
              kind: "skill",
              title: "Loaded skill",
              summary: `Loaded ${skill.name}`,
              target: skill.name,
            },
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
  let skills
  try {
    skills = await loader.list()
  } catch (error) {
    logger.warn(`Skill discovery failed while rendering system prompt: ${error instanceof Error ? error.message : String(error)}`)
    return ""
  }
  if (!skills.length) return ""
  if (skills.length > SKILL_PROMPT_LIST_LIMIT) {
    return [
      `Available skills: ${skills.length} installed local skills.`,
      "If the user request matches a skill name, trigger, platform, URL/domain, or described capability, use skill_search to retrieve candidates before other task tools, then load the matching Skill. Load the full SKILL.md only for the selected skill.",
    ].join("\n")
  }
  return [
    "Available skills:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}${skill.contract?.triggers?.length ? ` (triggers: ${skill.contract.triggers.join(", ")})` : ""}`),
    "If the user request matches a skill name, trigger, platform, URL/domain, or described capability, call the skill tool to load the matching SKILL.md before using generic web, shell, temporary scripts, or direct APIs. If the skill result lists reference files, call the skill tool again with { name, path } to load one safely.",
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
    renderSkillContract(skill),
    skill.files.length
      ? ["Reference files available through the skill tool:", ...skill.files.map((file) => `- ${file.path} (${file.size} bytes)`)].join("\n")
      : "Reference files: none",
    "Instructions:",
    skill.content,
  ]
    .filter(Boolean)
    .join("\n\n")
}

function renderSkillSearchLine(skill: Awaited<ReturnType<SkillLoader["list"]>>[number]) {
  const contract = [
    skill.contract?.triggers?.length ? `triggers=${skill.contract.triggers.join(", ")}` : "",
    skill.contract?.risk ? `risk=${skill.contract.risk}` : "",
    skill.contract?.required_tools?.length ? `tools=${skill.contract.required_tools.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ")
  return `- ${skill.name}: ${skill.description} (${skill.source.relativePath})${contract ? ` [${contract}]` : ""}`
}

function renderSkillContract(skill: Awaited<ReturnType<SkillLoader["load"]>>) {
  const contract = skill.contract
  if (!contract) return ""
  const lines = [
    contract.version ? `Version: ${contract.version}` : "",
    contract.risk ? `Risk: ${contract.risk}` : "",
    contract.triggers?.length ? `Triggers: ${contract.triggers.join(", ")}` : "",
    contract.when_to_use ? `When to use: ${contract.when_to_use}` : "",
    contract.when_not_to_use ? `When not to use: ${contract.when_not_to_use}` : "",
    contract.required_tools?.length ? `Required tools: ${contract.required_tools.join(", ")}` : "",
    contract.dependencies?.length ? `Dependencies: ${contract.dependencies.join(", ")}` : "",
    contract.inputs ? `Inputs: ${contract.inputs}` : "",
    contract.outputs ? `Outputs: ${contract.outputs}` : "",
    contract.quality_checks?.length ? `Quality checks: ${contract.quality_checks.join("; ")}` : "",
  ].filter(Boolean)
  return lines.length ? ["Contract:", ...lines].join("\n") : ""
}

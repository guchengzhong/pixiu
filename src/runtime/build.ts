import { mkdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

import type { PixiuConfig } from "../config/defaults"
import { loadConfig, resolveProviderConfig } from "../config/loader"
import { OpenAICompatibleClient } from "../llm/openai"
import type { LLMClient } from "../llm/types"
import type { SessionRecord } from "../session/types"
import type { ToolContext } from "../tools/types"
import { JsonlSessionStore } from "../session/jsonl"
import { JsonProjectStore } from "../session/projects"
import { ToolRegistry } from "../tools/registry"
import { createBuiltinTools } from "../tools/builtin"
import { createWebTools } from "../tools/web"
import { normalizePermissionRules, StaticPermissionManager } from "../permission/evaluator"
import type { PermissionDecision, PermissionMode, PermissionRequest } from "../permission/types"
import { PathGuard } from "../sandbox/path"
import { SkillLoader } from "../skills/loader"
import { createSkillTools, renderSkillSystemPrompt } from "../skills/tool"
import { createSkillHubTools } from "../skillhub/tools"
import { AgentRunner } from "../agent/runner"
import { createMCPClient } from "../mcp/status"
import { mcpToolsToDefinitions } from "../mcp/tools"
import { PixiuError } from "../shared/errors"
import { installAgentReach, installBrowserUse, managedEnvPathPrepend } from "../tools/managed-env"

export type RuntimeOptions = {
  cwd?: string
  config?: PixiuConfig
  yes?: boolean
  permissionMode?: PermissionMode
  interactivePermissions?: boolean
  askPermission?: (request: PermissionRequest, decision: PermissionDecision) => Promise<PermissionDecision>
  llm?: LLMClient
  signal?: AbortSignal
  loadLLM?: boolean
}

type RuntimeBase = {
  cwd: string
  config: PixiuConfig
  sessions: JsonlSessionStore
  projects: JsonProjectStore
  tools: ToolRegistry
  skills: SkillLoader
  permissions: StaticPermissionManager
  pathGuard: PathGuard
  close(): Promise<void>
}

export type Runtime = RuntimeBase & { runner: AgentRunner }
export type RuntimeWithoutLLM = RuntimeBase & { runner?: undefined }

export async function buildRuntime(options?: RuntimeOptions & { loadLLM?: true }): Promise<Runtime>
export async function buildRuntime(options: RuntimeOptions & { loadLLM: false }): Promise<RuntimeWithoutLLM>
// Builds the Pixiu runtime by loading the configuration, initializing the permission manager, session store, skill loader,
// tool registry, and optionally the LLM client and agent runner. The runtime provides all necessary components for running
// agents and tools, and abstracts away the initialization logic.
export async function buildRuntime(options: RuntimeOptions = {}): Promise<Runtime | RuntimeWithoutLLM> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const config = options.config ?? (await loadConfig({ cwd }))
  const permissionMode = options.yes ? "bypassPermissions" : (options.permissionMode ?? "default")
  const permissions = new StaticPermissionManager(
    normalizePermissionRules(config),
    {
      permissionMode,
      ...(options.yes
        ? { nonInteractive: true, autoApprove: true }
        : options.interactivePermissions
          ? { nonInteractive: false }
          : { nonInteractive: true }),
      ...(options.askPermission ? { ask: options.askPermission } : {}),
    },
  )
  const pathGuard = new PathGuard({ workspaceRoot: cwd, workspaceOnly: config.sandbox.workspaceOnly })
  const stateDir = join(cwd, ".pixiu/state")
  const sessions = new JsonlSessionStore(join(stateDir, "sessions"))
  const projects = new JsonProjectStore(stateDir, cwd)
  // skills: create skillloader with config paths. 
  const skills = new SkillLoader(config.skills.paths.map((path) => (path.startsWith("~") ? path : join(cwd, path))))
  const tools = new ToolRegistry()
    .registerMany(createBuiltinTools())
    .registerMany(createWebTools())
    .registerMany(createSkillTools(skills))
    .registerMany(createSkillHubTools(config.skillhub, cwd))
  const mcpClients: ReturnType<typeof createMCPClient>[] = []
  const close = async () => {
    await Promise.all(mcpClients.map((client) => client.close?.().catch(() => undefined)))
  }

  const base = { cwd, config, sessions, projects, tools, skills, permissions, pathGuard, close }
  if (options.loadLLM === false) return base

  for (const [name, server] of Object.entries(config.mcp)) {
    if (server.enabled === false) continue
    let client: ReturnType<typeof createMCPClient> | undefined
    try {
      client = createMCPClient(server)
      tools.registerMany(await mcpToolsToDefinitions(name, client))
      mcpClients.push(client)
    } catch {
      // MCP servers are optional extensions; a broken server should not hide built-in tools.
      await client?.close?.().catch(() => undefined)
    }
  }

  const provider = resolveProviderConfig(config)
  const llm = options.llm ?? createLLM({ provider })
  // inject the skill tool with the skill loader, so that the agent can load the skill instructions and reference files when needed.
  const skillPrompt = await renderSkillSystemPrompt(skills)
  const agentConfig = config.agents.default!
  const toolConfig = {
    shellTimeoutMs: config.sandbox.shellTimeoutMs,
    outputMaxBytes: config.sandbox.outputMaxBytes,
    envAllowlist: config.sandbox.envAllowlist,
    envPrependPath: managedEnvPathPrepend(config),
    ...(config.tools.managedEnv.enabled ? { envOverrides: { PYTHONNOUSERSITE: "1" } } : {}),
  }
  const createToolContext = (root: string): Omit<ToolContext, "sessionId"> => ({
    cwd: root,
    workspaceRoot: root,
    permissions,
    pathGuard: new PathGuard({ workspaceRoot: root, workspaceOnly: config.sandbox.workspaceOnly }),
    config: toolConfig,
  })
  const toolContextForSession = (session: SessionRecord) => createToolContext(session.cwd || cwd)
  const workspaceRoot =
    config.sandbox.workspaceDir && isAbsolute(config.sandbox.workspaceDir)
      ? config.sandbox.workspaceDir
      : resolve(cwd, config.sandbox.workspaceDir)
  const runnerOptions = {
    llm,
    tools,
    sessions,
    model: agentConfig.model ?? provider.model ?? config.model,
    systemPrompt: [agentConfig.systemPrompt, skillPrompt].filter(Boolean).join("\n\n"),
    toolNames: agentConfig.tools,
    maxSteps: agentConfig.maxSteps,
    compaction: config.compaction,
    managedTools: {
      autoInstall: config.tools.managedEnv.autoInstall,
      installAgentReach: ({ cwd }: { cwd: string }) => installAgentReach(config, { cwd }),
      installBrowserUse: ({ cwd }: { cwd: string }) => installBrowserUse(config, { cwd }),
    },
    toolContext: createToolContext(cwd),
    toolContextForSession,
    ...(config.sandbox.mode === "workspace"
      ? {
          async createSessionWorkspace(sessionId: string) {
            const sessionRoot = join(workspaceRoot, sessionId)
            await mkdir(sessionRoot, { recursive: true })
            return {
              cwd: sessionRoot,
              metadata: {
                sandboxMode: "workspace",
                workspaceDir: relative(cwd, sessionRoot),
              },
            }
          },
        }
      : {}),
  }
  const runner = new AgentRunner(options.signal ? { ...runnerOptions, signal: options.signal } : runnerOptions)

  return { ...base, runner }
}

function createLLM(options: {
  provider: ReturnType<typeof resolveProviderConfig>
}) {
  if (!options.provider.apiKey) {
    throw new PixiuError(
      "No provider API key configured. Set the provider apiKeyEnv environment variable before running the agent.",
      { code: "PROVIDER_API_KEY_MISSING" },
    )
  }
  return new OpenAICompatibleClient({
    baseURL: options.provider.baseURL ?? "https://api.openai.com/v1",
    apiKey: options.provider.apiKey,
  })
}

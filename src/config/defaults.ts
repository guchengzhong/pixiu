export type PermissionAction = "allow" | "ask" | "deny"

export type ProviderConfig = {
  type?: "openai-compatible" | "anthropic-compatible"
  baseURL?: string
  apiKeyEnv?: string
  apiKey?: string
  model?: string
}

export type PixiuConfig = {
  model: string
  providers: Record<string, ProviderConfig>
  agents: Record<
    string,
    {
      description: string
      systemPrompt?: string
      model?: string
      tools: string[]
      maxSteps: number
    }
  >
  permissions: Record<string, PermissionAction | { action: PermissionAction; pattern?: string }>
  skills: {
    paths: string[]
  }
  skillhub: {
    baseURL: string
    apiKeyEnv?: string
    installDir: string
  }
  ui: {
    accentColor: string
  }
  mcp: Record<
    string,
    {
      enabled?: boolean
      transport: "stdio" | "http"
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      headers?: Record<string, string>
      timeoutMs?: number
    }
  >
  sandbox: {
    mode: "local" | "workspace"
    workspaceDir: string
    workspaceOnly: boolean
    shellTimeoutMs: number
    outputMaxBytes: number
    envAllowlist: string[]
  }
  compaction: {
    maxApproxTokens: number
    keepRecentMessages: number
  }
}

// The default configuration for Pixiu,
// which can be overridden by a local config file. It includes the default model and provider settings,
// the default agent configuration, permission rules, skill paths, UI settings, and sandbox settings.
export const defaultConfig = {
  model: "openai-compatible/example-model",
  providers: {
    "openai-compatible": {
      type: "openai-compatible",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  },
  agents: {
    default: {
      description: "Default coding and research agent.",
      systemPrompt:
        [
          "You are Pixiu, a local-first self-evolving CLI agent. Help the user do real work in the current workspace, learn from each task, and turn repeated experience into reusable local skills when the user asks or the pattern is clearly durable.",
          "Use the core tools to inspect files, modify files, and execute commands in the workspace.",
          "For live data, current research, or specific URLs, prefer the generic web_search and web_fetch tools and record sources in the final artifact.",
          "For domain-specific APIs or one-off automation, create a temporary script under .pixiu/tmp or run a short shell command, inspect the result, and then write the requested artifact.",
          "Use local skills when a relevant skill is already available. Do not create durable skills, search remote skills, or install remote skills unless the user explicitly asks or approves.",
          "When a task asks for future or dated information, choose a data source and command that returns data for that exact date instead of a current-only summary.",
          "Do not pretend to have live data. Record the source URLs, commands, and access time when a task depends on external information.",
        ].join(" "),
      tools: ["read", "grep", "glob", "web_search", "web_fetch", "shell", "write", "edit", "patch", "todo", "skill"],
      maxSteps: 20,
    },
  },
  permissions: {
    read: "allow",
    grep: "allow",
    glob: "allow",
    shell: "ask",
    web_search: "ask",
    web_fetch: "ask",
    edit: "ask",
    write: "ask",
  },
  skills: {
    paths: [".pixiu/skills", ".opencode/skills", "~/.claude/skills", "~/.agents/skills"],
  },
  skillhub: {
    baseURL: "https://www.skillhub.club",
    apiKeyEnv: "SKILLHUB_API_KEY",
    installDir: ".pixiu/skills",
  },
  ui: {
    accentColor: "#3B8EEA",
  },
  mcp: {},
  sandbox: {
    mode: "workspace",
    workspaceDir: "workspace",
    workspaceOnly: true,
    shellTimeoutMs: 30_000,
    outputMaxBytes: 20_000,
    envAllowlist: ["PATH", "HOME", "USER", "LANG", "LC_ALL", "SHELL", "TMPDIR"],
  },
  compaction: {
    maxApproxTokens: 64_000,
    keepRecentMessages: 12,
  },
} satisfies PixiuConfig

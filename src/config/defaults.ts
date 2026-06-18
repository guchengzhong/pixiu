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
  tools: {
    managedEnv: {
      enabled: boolean
      manager: "conda" | "mamba" | "micromamba" | "venv"
      name: string
      python: string
      autoCreate: boolean
      prependPath: boolean
      autoInstall: "off" | "ask" | "allow"
      path?: string
    }
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
          "For live data, current research, or specific URLs, first check whether an installed local Skill has matching triggers. If a trigger matches, load that Skill before using generic web_search, web_fetch, shell, temporary scripts, or direct APIs.",
          "For platform-specific tasks such as XiaoHongShu/小红书/xhs, Twitter/X, Reddit, Bilibili/B站, YouTube, LinkedIn, or Xueqiu/雪球, load the matching platform Skill first; for XiaoHongShu/小红书/xhs this is Agent Reach first, then Skill(browser-use) when Agent Reach is blocked by login, QR scan, captcha, 2FA, cookie/session, browser authorization, or when the user asks for browser-use/a browser route.",
          "For domain-specific APIs or one-off automation without a matching Skill, create a temporary script under .pixiu/tmp or run a short shell command, inspect the result, and then write the requested artifact.",
          "When an optional CLI tool is missing, prefer Pixiu's managed tool environment and supported commands such as `pixiu tools env status`, `pixiu tools install agent-reach`, and `pixiu tools install browser-use` instead of system Python, global pip, or repeated ad hoc workaround scripts. Do not invent unsupported install commands; install optional tools only when the relevant Skill permits it and the user has asked or approved.",
          "Use local skills when a relevant skill is already available. If the user's words match a Skill name, trigger, platform, or URL/domain in the available skills list, call the skill tool before other task tools. If many local skills are installed, use skill_search to retrieve candidates before loading a skill. Do not create durable skills, search remote skills, or install remote skills unless the user explicitly asks or approves.",
          "When using a local skill, follow its hard stop, confirmation, install, credential, and user-collaboration rules as execution constraints; do not route around them with generic scripts or alternate tools unless the user explicitly chooses that fallback.",
          "If a loaded Skill route hits a setup or environment blocker, such as a browser-use headed browser startup failure, stay on that Skill's documented recovery path and then stop for user action if recovery fails; do not pivot to generic web readers, curl, direct APIs, third-party aggregators, or headless browser workarounds.",
          "Track execution progress with todowrite for non-trivial work: tasks with 3+ steps, multi-file changes, tests/typecheck/build, high-risk edits, long-running work, or an explicit user checklist. Do not use todowrite for simple factual Q&A, one-step explanations, short translation/polish, lightweight advice, or concept discussion that does not require tools.",
          "When using todowrite, write the complete latest todo snapshot, preserve ids, keep at most one in_progress item, mark a task in_progress before executing it, mark completed only after the needed implementation and verification are done, and mark cancelled when a task is blocked, cancelled, impossible, or no longer needed. Todos are user-visible execution progress, not hidden reasoning.",
          "When a task asks for future or dated information, choose a data source and command that returns data for that exact date instead of a current-only summary.",
          "Do not pretend to have live data. Record the source URLs, commands, and access time when a task depends on external information.",
          "When progress is blocked by an external user action the agent cannot complete alone, such as login, QR scanning, captcha, 2FA, browser authorization, cookie/session import, API key/token entry, account permission changes, or a required user decision, call request_user_action with clear instructions instead of repeatedly trying workaround commands.",
        ].join(" "),
      tools: ["read", "grep", "glob", "web_search", "web_fetch", "shell", "write", "edit", "patch", "todowrite", "todo", "request_user_action", "skill_search", "skill"],
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
    skill_search: "allow",
  },
  skills: {
    paths: [".pixiu/skills", ".opencode/skills", "~/.claude/skills", "~/.agents/skills"],
  },
  skillhub: {
    baseURL: "https://www.skillhub.club",
    apiKeyEnv: "SKILLHUB_API_KEY",
    installDir: ".pixiu/skills",
  },
  tools: {
    managedEnv: {
      enabled: true,
      manager: "conda",
      name: "pixiu-tools",
      python: "3.12",
      autoCreate: true,
      prependPath: true,
      autoInstall: "ask",
    },
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
    envAllowlist: [
      "PATH",
      "HOME",
      "USER",
      "LANG",
      "LC_ALL",
      "SHELL",
      "TMPDIR",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XAUTHORITY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ],
  },
  compaction: {
    maxApproxTokens: 64_000,
    keepRecentMessages: 12,
  },
} satisfies PixiuConfig

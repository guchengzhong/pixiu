import { createID } from "../shared/id"
import { stripToolActivityInput } from "../activity/format"
import { formatError } from "../shared/errors"
import type { LLMClient, LLMMessage } from "../llm/types"
import type { SessionRecord, SessionStore } from "../session/types"
import { toLLMMessages } from "../session/format"
import type { ToolContext } from "../tools/types"
import type { ToolRegistry } from "../tools/registry"
import type { AgentEvent } from "./events"
import { approximateTokens, compactMessages } from "./compaction"
import type { JsonObject, JsonValue } from "../shared/json"
import type { TodoItem, TodoPriority, TodoStatus } from "../todo/types"

export type AgentRunnerOptions = {
  llm: LLMClient
  tools: ToolRegistry
  sessions: SessionStore
  toolContext: Omit<ToolContext, "sessionId">
  createSessionWorkspace?: (sessionId: string) => Promise<{ cwd: string; metadata?: JsonObject }> | { cwd: string; metadata?: JsonObject }
  toolContextForSession?: (session: SessionRecord) => Omit<ToolContext, "sessionId">
  model: string
  systemPrompt: string
  toolNames?: string[]
  maxSteps: number
  signal?: AbortSignal
  compaction?: {
    maxApproxTokens: number
    keepRecentMessages: number
  }
  managedTools?: {
    autoInstall?: "off" | "ask" | "allow"
    installAgentReach?: (input: { cwd: string; signal?: AbortSignal }) => Promise<{
      exitCode: number | null
      stdout: string
      stderr: string
    }>
    installBrowserUse?: (input: { cwd: string; signal?: AbortSignal }) => Promise<{
      exitCode: number | null
      stdout: string
      stderr: string
    }>
  }
}

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async *run(input: { message: string; sessionId?: string; title?: string; signal?: AbortSignal }): AsyncIterable<AgentEvent> {
    const session =
      input.sessionId && (await this.options.sessions.getSession(input.sessionId))
        ? (await this.options.sessions.getSession(input.sessionId))!
        : await this.createSession(input)

    yield { type: "session_created", sessionId: session.id }

    await this.options.sessions.appendMessage({
      sessionId: session.id,
      role: "user",
      parts: [{ type: "text", text: input.message }],
    })

    const continuationMessages: LLMMessage[] = []
    const skillRouteState = createSkillRouteState()
    let draftContinuations = 0
    for (let step = 0; step < this.options.maxSteps; step += 1) {
      const storedMessages = await this.options.sessions.readMessages(session.id)
      const currentSession = (await this.options.sessions.getSession(session.id)) ?? session
      const compacted = this.options.compaction ? compactMessages(storedMessages, this.options.compaction) : { messages: storedMessages }
      if (compacted.summary) {
        const nextSummary = mergeSessionSummary(currentSession.summary, compacted.summary)
        await this.options.sessions.updateSession(session.id, { summary: nextSummary })
        currentSession.summary = nextSummary
      }

      const messages: LLMMessage[] = [
        {
          role: "system",
          content: [this.options.systemPrompt, AGENT_COMPLETION_PROTOCOL, currentSession.summary ? `Conversation summary:\n${currentSession.summary}` : ""]
            .filter(Boolean)
            .join("\n\n"),
        },
        ...toLLMMessages(compacted.messages),
        ...continuationMessages,
      ]

      yield { type: "context_usage", inputTokens: estimateLLMInputTokens(messages), source: "estimated" }

      const toolCalls = []
      let assistantText = ""
      let progressYielded = false
      try {
        for await (const event of this.options.llm.stream(
          {
            model: this.options.model,
            messages,
            tools: this.options.tools.toLLMTools(this.options.toolNames),
            toolChoice: "auto",
          },
          input.signal ?? this.options.signal,
        )) {
          if (event.type === "text_delta") {
            assistantText += event.text
          }
          if (event.type === "usage") {
            const inputTokens = event.usage.inputTokens ?? event.usage.totalTokens
            if (inputTokens !== undefined) {
              yield {
                type: "context_usage",
                inputTokens,
                ...(event.usage.outputTokens !== undefined ? { outputTokens: event.usage.outputTokens } : {}),
                source: "provider",
              }
            }
          }
          if (event.type === "tool_call") {
            if (!progressYielded && assistantText.trim()) {
              progressYielded = true
              yield { type: "assistant_progress_delta", text: assistantText.trim() }
            }
            toolCalls.push(event.call)
            yield { type: "tool_call", id: event.call.id, name: event.call.name, input: event.call.input }
          }
          if (event.type === "error") {
            await this.options.sessions.appendMessage({
              sessionId: session.id,
              role: "assistant",
              parts: [
                ...(assistantText ? [{ type: "text" as const, text: assistantText }] : []),
                { type: "error", message: event.error, ...(event.code ? { code: event.code } : {}) },
              ],
            })
            yield { type: "error", message: event.error }
            yield { type: "finish", reason: "error", sessionId: session.id }
            return
          }
        }
      } catch (error) {
        if ((input.signal ?? this.options.signal)?.aborted || isAbortError(error)) {
          yield { type: "finish", reason: "cancelled", sessionId: session.id }
          return
        }
        const message = formatError(error)
        await this.options.sessions.appendMessage({
          sessionId: session.id,
          role: "assistant",
          parts: [{ type: "error", message }],
        })
        yield { type: "error", message }
        yield { type: "finish", reason: "error", sessionId: session.id }
        return
      }

      if (toolCalls.length) {
        await this.options.sessions.appendMessage({
          sessionId: session.id,
          role: "assistant",
          parts: [
            ...(assistantText ? [{ type: "text" as const, text: assistantText }] : []),
            ...toolCalls.map((call) => ({ type: "tool_call" as const, id: call.id, name: call.name, input: stripToolActivityInput(call.input) })),
          ],
        })
        continuationMessages.length = 0
        draftContinuations = 0

        const persistedCallIds = new Set<string>()
        for (const call of toolCalls) {
          const signal = input.signal ?? this.options.signal
          if (signal?.aborted) {
            // Persist a result for every declared tool_call before bailing out, so the
            // stored history never contains an assistant tool_call without a matching
            // tool result (an orphan makes later LLM requests structurally illegal).
            await this.persistCancelledToolResults(session.id, toolCalls.filter((item) => !persistedCallIds.has(item.id)))
            yield { type: "finish", reason: "cancelled", sessionId: session.id }
            return
          }
          const baseToolContext = this.options.toolContextForSession?.(session) ?? this.options.toolContext
          const toolContext = {
            ...baseToolContext,
            sessionId: session.id,
          }
          const cleanInput = stripToolActivityInput(call.input)
          const blockedResult = skillRouteGuardResult(skillRouteState, call.name, cleanInput)
          const result = blockedResult ?? await this.options.tools.execute(
            call.name,
            cleanInput,
            signal ? { ...toolContext, signal } : toolContext,
          )
          updateSkillRouteState(skillRouteState, call.name, cleanInput, result.ok, result.content, result.metadata)
          if (signal?.aborted) {
            // The current call already ran but was not yet persisted; persist it and any
            // remaining calls as results so no assistant tool_call is left orphaned.
            await this.options.sessions.appendMessage({
              sessionId: session.id,
              role: "tool",
              parts: [{ type: "tool_result", toolCallId: call.id, name: call.name, result }],
            })
            persistedCallIds.add(call.id)
            await this.persistCancelledToolResults(session.id, toolCalls.filter((item) => !persistedCallIds.has(item.id)))
            yield { type: "finish", reason: "cancelled", sessionId: session.id }
            return
          }
          await this.options.sessions.appendMessage({
            sessionId: session.id,
            role: "tool",
            parts: [{ type: "tool_result", toolCallId: call.id, name: call.name, result }],
          })
          persistedCallIds.add(call.id)
          const toolEvent = {
            type: "tool_result",
            id: call.id,
            name: call.name,
            ok: result.ok,
            content: result.content,
          } satisfies AgentEvent
          yield result.metadata ? { ...toolEvent, metadata: result.metadata } : toolEvent
          const todoEvent = todoUpdatedEvent(session.id, result.ok, result.metadata)
          if (todoEvent) {
            await this.options.sessions.updateTodos(session.id, todoEvent.todos)
            yield todoEvent
          }
          const autoInstallEvents = await this.autoInstallManagedToolIfAllowed(skillRouteState, session, input.signal ?? this.options.signal)
          for (const autoInstallEvent of autoInstallEvents) yield autoInstallEvent
        }
        continue
      }

      const finalAnswer = parseFinalAnswer(assistantText)
      if (finalAnswer !== undefined) {
        await this.options.sessions.appendMessage({
          sessionId: session.id,
          role: "assistant",
          parts: [{ type: "text", text: finalAnswer }],
        })
        if (finalAnswer) yield { type: "llm_text_delta", text: finalAnswer }
        yield { type: "message", role: "assistant", content: finalAnswer }
        yield { type: "finish", reason: "stop", sessionId: session.id }
        return
      }

      if (!assistantText.trim()) {
        if (draftContinuations >= 1) {
          const message = "LLM returned an empty response without tool calls."
          await this.options.sessions.appendMessage({
            sessionId: session.id,
            role: "assistant",
            parts: [{ type: "error", message, code: "EMPTY_LLM_RESPONSE" }],
          })
          yield { type: "error", message }
          yield { type: "finish", reason: "error", sessionId: session.id }
          return
        }

        draftContinuations += 1
        continuationMessages.push({
          role: "user",
          content:
            "Continue the task. Your previous response was empty and did not call a tool. If work remains, call the appropriate tool now. If you just checked browser-use successfully for a visible browser fallback, continue by loading Skill(browser-use) if needed and opening the headed browser with a fresh task-specific session. If the task is already fully answered, reply with FINAL: followed by the answer.",
        })
        continue
      }

      if (draftContinuations >= 1) {
        const fallbackAnswer = parseFinalAnswer(assistantText) ?? assistantText.trim()
        await this.options.sessions.appendMessage({
          sessionId: session.id,
          role: "assistant",
          parts: [{ type: "text", text: fallbackAnswer }],
        })
        yield { type: "llm_text_delta", text: fallbackAnswer }
        yield { type: "message", role: "assistant", content: fallbackAnswer }
        yield { type: "finish", reason: "stop", sessionId: session.id }
        return
      }

      draftContinuations += 1
      continuationMessages.push(
        { role: "assistant", content: assistantText },
        {
          role: "user",
          content:
            "Continue the task. Your previous response was not a final answer because it did not start with FINAL:. If work remains, call the appropriate tool now. If the task is already fully answered, reply with FINAL: followed by the answer.",
        },
      )
    }

    const message = `Stopped after maxSteps=${this.options.maxSteps}`
    await this.options.sessions.appendMessage({
      sessionId: session.id,
      role: "assistant",
      id: createID("msg"),
      parts: [{ type: "error", message, code: "MAX_STEPS" }],
    })
    yield { type: "error", message }
    yield { type: "finish", reason: "max_steps", sessionId: session.id }
  }

  private async createSession(input: { message: string; title?: string }) {
    const id = createID("session")
    const workspace = await this.options.createSessionWorkspace?.(id)
    return this.options.sessions.create({
      id,
      cwd: workspace?.cwd ?? this.options.toolContext.cwd,
      title: input.title ?? input.message.slice(0, 60),
      ...(workspace?.metadata ? { metadata: workspace.metadata } : {}),
    })
  }

  private async persistCancelledToolResults(sessionId: string, calls: { id: string; name: string }[]) {
    for (const call of calls) {
      await this.options.sessions.appendMessage({
        sessionId,
        role: "tool",
        parts: [
          {
            type: "tool_result",
            toolCallId: call.id,
            name: call.name,
            result: { ok: false, content: "Tool call cancelled before completion." },
          },
        ],
      })
    }
  }

  private async autoInstallManagedToolIfAllowed(
    state: SkillRouteState,
    session: SessionRecord,
    signal: AbortSignal | undefined,
  ): Promise<AgentEvent[]> {
    const blocker = state.blockers.find(
      (item): item is Extract<SkillRouteBlocker, { kind: "missing_managed_tool" }> =>
        item.kind === "missing_managed_tool" && Boolean(managedToolDefinition(item.tool, item.skill)),
    )
    if (!blocker || blocker.autoInstallAttempted) return []
    if (this.options.managedTools?.autoInstall !== "allow") return []
    const definition = managedToolDefinition(blocker.tool, blocker.skill)
    const installer = definition ? this.managedToolInstaller(definition.tool) : undefined
    if (!definition || !installer) return []

    blocker.autoInstallAttempted = true
    const baseToolContext = this.options.toolContextForSession?.(session) ?? this.options.toolContext
    const id = createID("call")
    const input = {
      command: definition.installCommand,
      purpose: definition.installPurpose,
      _activity: {
        kind: "shell",
        title: definition.installActivityTitle,
        summary: definition.installActivitySummary,
        target: definition.tool,
      },
    } satisfies JsonObject
    await this.options.sessions.appendMessage({
      sessionId: session.id,
      role: "assistant",
      parts: [{ type: "tool_call", id, name: "shell", input: stripToolActivityInput(input) }],
    })

    const install = await installer({ cwd: baseToolContext.cwd, ...(signal ? { signal } : {}) })
    const content = [install.stdout.trim(), install.stderr.trim()].filter(Boolean).join("\n") || `exitCode: ${install.exitCode ?? -1}`
    const ok = install.exitCode === 0
    const result = {
      ok,
      content,
      metadata: {
        command: input.command,
        exitCode: install.exitCode ?? -1,
        managedTool: definition.tool,
        managedToolAutoInstall: true,
        blocker,
        activity: {
          kind: "shell",
          title: ok ? definition.installedActivityTitle : definition.installFailedActivityTitle,
          summary: ok ? definition.installedActivitySummary : definition.installFailedActivitySummary,
          command: input.command,
          target: definition.tool,
          status: ok ? "success" : "error",
          details: {
            exitCode: install.exitCode ?? -1,
            managedTool: definition.tool,
            autoInstall: true,
          },
        },
      },
    } satisfies {
      ok: boolean
      content: string
      metadata: JsonObject
    }

    updateSkillRouteState(state, "shell", stripToolActivityInput(input), result.ok, result.content, result.metadata)
    await this.options.sessions.appendMessage({
      sessionId: session.id,
      role: "tool",
      parts: [{ type: "tool_result", toolCallId: id, name: "shell", result }],
    })
    return [
      { type: "tool_call", id, name: "shell", input },
      { type: "tool_result", id, name: "shell", ok: result.ok, content: result.content, metadata: result.metadata },
    ]
  }

  private managedToolInstaller(tool: ManagedToolName) {
    if (tool === "agent-reach") return this.options.managedTools?.installAgentReach
    if (tool === "browser-use") return this.options.managedTools?.installBrowserUse
    return undefined
  }
}

type SkillRouteState = {
  loadedSkills: Set<string>
  blockers: SkillRouteBlocker[]
}

type ManagedToolName = "agent-reach" | "browser-use"

type ManagedToolDefinition = {
  skill: string
  tool: ManagedToolName
  commandPattern: RegExp
  notFoundPattern: RegExp
  installAllowedPattern: RegExp
  installCommand: string
  installPurpose: string
  installActivityTitle: string
  installActivitySummary: string
  installedActivityTitle: string
  installedActivitySummary: string
  installFailedActivityTitle: string
  installFailedActivitySummary: string
  missingContent: string[]
  missingTitle: string
  missingReason: string
  missingInstructions: string[]
  missingSummary: string
}

const MANAGED_TOOL_DEFINITIONS: ManagedToolDefinition[] = [
  {
    skill: "agent-reach",
    tool: "agent-reach",
    commandPattern: /(^|[\s;&|()])agent-reach(\s|$)|\bcommand\s+-v\s+agent-reach\b/,
    notFoundPattern: /(?:agent-reach|command): not found|not recognized/i,
    installAllowedPattern: /^\s*pixiu\s+tools\s+install\s+agent-reach\s+--yes\s*$/,
    installCommand: "pixiu tools install agent-reach --yes",
    installPurpose: "安装 Agent Reach 到 Pixiu 托管工具环境",
    installActivityTitle: "安装 Agent Reach",
    installActivitySummary: "Installing Agent Reach into the Pixiu managed tool environment.",
    installedActivityTitle: "Installed Agent Reach",
    installedActivitySummary: "Installed Agent Reach into the Pixiu managed tool environment.",
    installFailedActivityTitle: "Agent Reach install failed",
    installFailedActivitySummary: "Could not install Agent Reach into the Pixiu managed tool environment.",
    missingContent: [
      "Agent Reach is missing from the active tool environment.",
      "Use `request_user_action` to ask for installation approval, or run `pixiu tools install agent-reach --yes` to install it into Pixiu's managed tool environment.",
      "Do not continue with ad hoc scraping, private endpoint probing, browser automation experiments, or unrelated fallback commands while this blocker is active.",
    ],
    missingTitle: "需要安装 Agent Reach",
    missingReason: "Agent Reach 当前未安装到 Pixiu managed tool environment。",
    missingInstructions: [
      "允许 Pixiu 安装 Agent Reach 到 managed tool environment，或手动运行 `pixiu tools install agent-reach --yes`。",
      "安装完成后回复继续，Pixiu 会重新运行 `agent-reach doctor --json`。",
    ],
    missingSummary: "Agent Reach 缺失，等待安装授权或 managed env 安装。",
  },
  {
    skill: "browser-use",
    tool: "browser-use",
    commandPattern: /(^|[\s;&|()])browser-use(\s|$)|\bcommand\s+-v\s+browser-use\b/,
    notFoundPattern: /(?:browser-use|command): not found|not recognized/i,
    installAllowedPattern: /^\s*pixiu\s+tools\s+install\s+browser-use\s+--yes\s*$/,
    installCommand: "pixiu tools install browser-use --yes",
    installPurpose: "安装 browser-use 到 Pixiu 托管工具环境",
    installActivityTitle: "安装 browser-use",
    installActivitySummary: "Installing browser-use into the Pixiu managed tool environment.",
    installedActivityTitle: "Installed browser-use",
    installedActivitySummary: "Installed browser-use into the Pixiu managed tool environment.",
    installFailedActivityTitle: "browser-use install failed",
    installFailedActivitySummary: "Could not install browser-use into the Pixiu managed tool environment.",
    missingContent: [
      "browser-use is missing from the active tool environment.",
      "Use `request_user_action` to ask for installation approval, or run `pixiu tools install browser-use --yes` to install it into Pixiu's managed tool environment.",
      "Do not continue with ad hoc scraping, private endpoint probing, third-party aggregators, or unrelated fallback commands while this browser route blocker is active.",
    ],
    missingTitle: "需要安装 browser-use",
    missingReason: "browser-use 当前未安装到 Pixiu managed tool environment。",
    missingInstructions: [
      "允许 Pixiu 安装 browser-use 到 managed tool environment，或手动运行 `pixiu tools install browser-use --yes`。",
      "安装完成后回复继续，Pixiu 会重新运行 `browser-use doctor` 或 `browser-use --help`。",
    ],
    missingSummary: "browser-use 缺失，等待安装授权或 managed env 安装。",
  },
]

type SkillRouteBlocker =
  | {
      kind: "missing_managed_tool"
      skill: string
      tool: string
      autoInstallAttempted?: boolean
    }
  | {
      kind: "user_action_required"
      skill: string
      category: "auth" | "captcha" | "approval" | "input" | "secret" | "environment" | "other"
      title: string
      reason: string
      instructions: string[]
      resumeHint: string
      signal: string
      tool?: string
    }

function createSkillRouteState(): SkillRouteState {
  return {
    loadedSkills: new Set(),
    blockers: [],
  }
}

function skillRouteGuardResult(state: SkillRouteState, toolName: string, input: JsonObject) {
  if (toolName === "request_user_action") return undefined
  const blocker = activeSkillRouteBlocker(state)
  if (blocker?.kind === "missing_managed_tool") {
    if (isAllowedManagedToolInstall(toolName, input, blocker)) return undefined
    return missingManagedToolBlockedResult(blocker)
  }
  const browserUseRouteBlock = browserUseRouteGuardResult(state, toolName, input)
  if (browserUseRouteBlock) return browserUseRouteBlock
  if (!blocker) return undefined
  if (isAllowedBrowserUseHandoff(toolName, input, blocker)) return undefined
  if (blocker.kind === "user_action_required") {
    return {
      ok: false,
      content: [
        blocker.title,
        blocker.reason,
        "Use `request_user_action` with the provided instructions instead of continuing with workaround commands.",
      ].join("\n"),
      metadata: {
        skillRouteBlocked: true,
        blocker,
        userActionRequired: true,
        category: blocker.category,
        title: blocker.title,
        reason: blocker.reason,
        instructions: blocker.instructions,
        resumeHint: blocker.resumeHint,
        activity: {
          kind: "permission",
          title: blocker.title,
          summary: blocker.reason,
          status: "skipped",
          details: {
            blocker,
            allowedNext: allowedNextForUserActionBlocker(blocker),
          },
        },
      },
    }
  }
  return undefined
}

function missingManagedToolBlockedResult(blocker: Extract<SkillRouteBlocker, { kind: "missing_managed_tool" }>) {
  const definition = managedToolDefinition(blocker.tool, blocker.skill)
  return {
    ok: false,
    content: (definition?.missingContent ?? ["A required managed tool is missing from the active tool environment."]).join("\n"),
    metadata: {
      skillRouteBlocked: true,
      blocker,
      userActionRequired: true,
      category: "environment",
      title: definition?.missingTitle ?? "需要安装 managed tool",
      reason: definition?.missingReason ?? `${blocker.tool} 当前未安装到 Pixiu managed tool environment。`,
      instructions: definition?.missingInstructions ?? [`安装 ${blocker.tool} 后回复“继续”。`],
      resumeHint: "完成安装后回复“继续”。",
      activity: {
        kind: "permission",
        title: definition?.missingTitle ?? "需要安装 managed tool",
        summary: definition?.missingSummary ?? `${blocker.tool} 缺失，等待安装授权或 managed env 安装。`,
        status: "skipped",
        details: {
          blocker,
          allowedNext: ["request_user_action", ...(definition ? [definition.installCommand] : [])],
        },
      },
    },
  }
}

function browserUseRouteGuardResult(state: SkillRouteState, toolName: string, input: JsonObject) {
  if (!state.loadedSkills.has("browser-use")) return undefined
  if (toolName === "skill" && stringJsonValue(input.name) === "browser-use") return undefined
  if (toolName === "shell") {
    const command = stringJsonValue(input.command)
    if (command && isAllowedBrowserUseRouteCommand(command)) return undefined
    return browserUseRouteBlockedResult(command)
  }
  if (toolName === "web_search" || toolName === "web_fetch") return browserUseRouteBlockedResult(toolName)
  return undefined
}

function isAllowedBrowserUseRouteCommand(command: string) {
  const browserUse = managedToolDefinition("browser-use", "browser-use")
  return Boolean(
    browserUse &&
      (isManagedToolCommand(command, browserUse) ||
        isBrowserUseRouteDiagnosticCommand(command) ||
        browserUse.installAllowedPattern.test(command) ||
        /^\s*pixiu\s+tools\s+install\s+browser-use(?:\s+--yes)?\s*$/.test(command) ||
        /^\s*pixiu\s+tools\s+env\s+status\s*$/.test(command)),
  )
}

function isBrowserUseRouteDiagnosticCommand(command: string) {
  const normalized = command.trim()
  return /^(?:env|printenv)(?:\s|$)/.test(normalized) ||
    /^(?:echo|printf)\s+/.test(normalized) ||
    /^(?:which|type)\s+browser-use\s*$/.test(normalized) ||
    /^command\s+-v\s+browser-use\s*$/.test(normalized) ||
    /^ps\s+/.test(normalized) ||
    /^ls\s+-l\s+(?:\/usr\/bin\/(?:firefox|google-chrome|chromium|chromium-browser)|\/home\/\S*browser-use\S*)/.test(normalized)
}

function browserUseRouteBlockedResult(attempted?: string) {
  const details = {
    allowedNext: ["browser-use doctor", "browser-use --headed --session <name> open <url>", "browser-use --session <name> state", "request_user_action"],
    ...(attempted ? { attempted } : {}),
  } satisfies JsonObject
  const metadata = {
    skillRouteBlocked: true,
    browserUseRouteBlocked: true,
    ...(attempted ? { attempted } : {}),
    activity: {
      kind: "permission",
      title: "browser-use route active",
      summary: "Blocked a non-browser-use fallback while browser-use is the active route.",
      status: "skipped",
      details,
    },
  } satisfies JsonObject
  return {
    ok: false,
    content: [
      "browser-use route is active.",
      "Continue with browser-use CLI commands such as `browser-use doctor`, `browser-use --headed --session <name> open <url>`, `browser-use --session <name> state`, or `request_user_action`.",
      "Do not use Jina Reader, curl scraping, direct/private APIs, third-party aggregators, temporary scripts, or unrelated fallback routes while browser-use is selected.",
    ].join("\n"),
    metadata,
  }
}

function activeSkillRouteBlocker(state: SkillRouteState) {
  return (
    state.blockers.find((item) => item.kind === "missing_managed_tool" && item.skill === "browser-use" && state.loadedSkills.has("browser-use")) ??
    state.blockers.find((item) => item.kind === "user_action_required" && state.loadedSkills.has(item.skill)) ??
    state.blockers.find((item) => item.kind === "missing_managed_tool" && state.loadedSkills.has(item.skill))
  )
}

function updateSkillRouteState(
  state: SkillRouteState,
  toolName: string,
  input: JsonObject,
  ok: boolean,
  content: string,
  metadata: JsonObject | undefined,
) {
  if (toolName === "skill" && ok) {
    const skillName = stringJsonValue(metadata?.name) ?? stringJsonValue(input.name)
    if (skillName) state.loadedSkills.add(skillName)
  }
  if (toolName !== "shell") return
  const command = stringJsonValue(metadata?.command) ?? stringJsonValue(input.command)
  if (!command) return
  const commandDefinition = managedToolCommandDefinition(command)
  const installDefinition = managedToolInstallDefinition(toolName, input)
  const recoveredDefinition = commandDefinition ?? installDefinition
  if (ok && recoveredDefinition) {
    state.blockers = state.blockers.filter(
      (item) => !(item.kind === "missing_managed_tool" && item.skill === recoveredDefinition.skill && item.tool === recoveredDefinition.tool),
    )
    return
  }
  for (const definition of MANAGED_TOOL_DEFINITIONS) {
    if (!state.loadedSkills.has(definition.skill)) continue
    if (!isManagedToolCommand(command, definition)) continue
    if (!isCommandNotFoundResult(content, metadata, definition)) continue
    upsertSkillRouteBlocker(state, { kind: "missing_managed_tool", skill: definition.skill, tool: definition.tool })
    return
  }
  if (!state.loadedSkills.has("agent-reach")) return
  const userActionBlocker = detectUserActionBlocker(content, command)
  if (userActionBlocker) {
    upsertSkillRouteBlocker(state, userActionBlocker)
    return
  }
}

function isAllowedManagedToolInstall(toolName: string, input: JsonObject, blocker: Extract<SkillRouteBlocker, { kind: "missing_managed_tool" }>) {
  const definition = managedToolDefinition(blocker.tool, blocker.skill)
  return Boolean(definition && managedToolInstallDefinition(toolName, input)?.tool === definition.tool)
}

function isAllowedBrowserUseHandoff(toolName: string, input: JsonObject, blocker: SkillRouteBlocker) {
  if (blocker.kind !== "user_action_required") return false
  if (blocker.skill !== "agent-reach") return false
  if (!["login_required", "qr_scan_required", "captcha_or_2fa_required", "cookie_or_session_required"].includes(blocker.signal)) return false
  if (toolName === "skill") return stringJsonValue(input.name) === "browser-use"
  if (toolName !== "shell") return false
  const command = stringJsonValue(input.command)
  if (!command) return false
  const browserUse = managedToolDefinition("browser-use", "browser-use")
  return Boolean(browserUse && (isManagedToolCommand(command, browserUse) || browserUse.installAllowedPattern.test(command)))
}

function allowedNextForUserActionBlocker(blocker: Extract<SkillRouteBlocker, { kind: "user_action_required" }>) {
  const allowed = ["request_user_action"]
  if (isAllowedBrowserUseHandoff("skill", { name: "browser-use" }, blocker)) {
    allowed.push("Skill(browser-use)", "browser-use doctor", "browser-use --headed --session <name> open <url>")
  }
  return allowed
}

function managedToolInstallDefinition(toolName: string, input: JsonObject) {
  if (toolName !== "shell") return undefined
  const command = stringJsonValue(input.command)
  return command ? MANAGED_TOOL_DEFINITIONS.find((definition) => definition.installAllowedPattern.test(command)) : undefined
}

function managedToolCommandDefinition(command: string) {
  return MANAGED_TOOL_DEFINITIONS.find((definition) => isManagedToolCommand(command, definition))
}

function managedToolDefinition(tool: string, skill?: string) {
  return MANAGED_TOOL_DEFINITIONS.find((definition) => definition.tool === tool && (!skill || definition.skill === skill))
}

function isManagedToolCommand(command: string, definition: ManagedToolDefinition) {
  return definition.commandPattern.test(command)
}

function isCommandNotFoundResult(content: string, metadata: JsonObject | undefined, definition: ManagedToolDefinition) {
  const exitCode = typeof metadata?.exitCode === "number" ? metadata.exitCode : undefined
  return exitCode === 127 || definition.notFoundPattern.test(content)
}

function detectUserActionBlocker(content: string, command: string): SkillRouteBlocker | undefined {
  const text = [command, content].join("\n")
  if (/(captcha|验证码|安全验证|2fa|mfa|two[-\s]?factor|verification code|短信验证码)/i.test(text)) {
    return userActionBlocker({
      category: "captcha",
      signal: "captcha_or_2fa_required",
      title: "需要完成验证码或二次验证",
      reason: "平台返回了验证码、CAPTCHA 或 2FA 要求，Pixiu 不能独自完成该账号操作。",
      instructions: [
        "在对应平台或 Agent Reach 推荐的登录/授权界面完成验证码、CAPTCHA 或 2FA。",
        "不要把验证码、Cookie 或账号密码直接粘贴到普通对话里；优先使用 Agent Reach 的配置/登录命令保存本地授权。",
        "完成后回复“继续”，Pixiu 会重新检查可用状态并继续任务。",
      ],
    })
  }
  if (/(qr code|scan.*qr|扫码|二维码)/i.test(text)) {
    return userActionBlocker({
      category: "auth",
      signal: "qr_scan_required",
      title: "需要扫码登录或授权",
      reason: "平台要求扫码登录或浏览器授权，Pixiu 不能代替用户完成该账号操作。",
      instructions: [
        "在本地浏览器、二维码界面或 Agent Reach 推荐后端中完成扫码登录。",
        "如果当前服务器无法显示二维码，请在有浏览器能力的本地环境完成一次登录或导入授权。",
        "完成后回复“继续”，Pixiu 会重新运行诊断并继续。",
      ],
    })
  }
  if (/(cookie|session).*(missing|required|not found|expired|invalid)|(?:missing|required|not found|expired|invalid).*(cookie|session)/i.test(text)) {
    return userActionBlocker({
      category: "auth",
      signal: "cookie_or_session_required",
      title: "需要登录态或 Cookie",
      reason: "平台访问需要有效登录态、Cookie 或 session，Pixiu 不能自行获取用户账号授权。",
      instructions: [
        "通过 Agent Reach 的配置/登录流程导入对应平台的本地授权，或在本地完成一次登录。",
        "只使用专用小号或你确认可以授权的账号；不要在普通聊天里暴露完整 Cookie。",
        "完成后回复“继续”，Pixiu 会重新检查平台后端状态。",
      ],
    })
  }
  if (/(not logged in|login required|please log in|please login|run [`']?[^`'\n]*login[`']?|unauthorized|authentication required|auth required|需要登录|请先登录|未登录)/i.test(text)) {
    return userActionBlocker({
      category: "auth",
      signal: "login_required",
      title: "需要登录或授权",
      reason: "平台返回了未登录或需要授权的状态，Pixiu 不能绕过账号登录要求。",
      instructions: [
        "在 Agent Reach 推荐的后端或对应平台客户端完成登录/授权。",
        "如果需要扫码、Cookie 或浏览器扩展授权，请在本地完成，不要尝试私有接口绕过。",
        "完成后回复“继续”，Pixiu 会重新运行诊断并继续任务。",
      ],
    })
  }
  return undefined
}

function userActionBlocker(input: Omit<Extract<SkillRouteBlocker, { kind: "user_action_required" }>, "kind" | "skill" | "resumeHint"> & { resumeHint?: string }): SkillRouteBlocker {
  return {
    kind: "user_action_required",
    skill: "agent-reach",
    resumeHint: "完成后回复“继续”。",
    ...input,
  }
}

function upsertSkillRouteBlocker(state: SkillRouteState, blocker: SkillRouteBlocker) {
  if (state.blockers.some((item) => sameSkillRouteBlocker(item, blocker))) return
  state.blockers.push(blocker)
}

function sameSkillRouteBlocker(left: SkillRouteBlocker, right: SkillRouteBlocker) {
  if (left.kind !== right.kind || left.skill !== right.skill) return false
  if (left.kind === "missing_managed_tool" && right.kind === "missing_managed_tool") return left.tool === right.tool
  if (left.kind === "user_action_required" && right.kind === "user_action_required") return left.signal === right.signal
  return false
}

function stringJsonValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

const AGENT_COMPLETION_PROTOCOL = [
  "Completion protocol:",
  "If the user asks for work that requires files, commands, live data, or other external state, call tools instead of describing what you will do.",
  "For shell calls, include `purpose` when the command would otherwise render as noisy developer output. `purpose` is a concise user-visible intent, not a verified result, and it is not passed to the shell process.",
  "When calling a tool, you may include a Pixiu-only `_activity` object to describe the concise user-visible intent of that tool call. `_activity.title` should describe what you are trying to do, not the raw command. Keep it factual, omit secrets, and use it only when it improves readability. The runtime strips `_activity` before executing tools.",
  "When a loaded Skill gives hard stop, confirmation, install, credential, or user-collaboration rules, treat those rules as execution constraints for that Skill route. Do not route around them with generic scripts or alternate tools unless the user explicitly chooses that fallback.",
  "If the task is blocked by a required external user action such as login, QR scan, captcha, 2FA, browser authorization, cookie/session import, API key/token entry, account permission changes, or a user decision, call request_user_action with concrete instructions and a resume hint instead of repeatedly trying workaround commands.",
  "Examples: shell {\"command\":\"npm run typecheck\",\"purpose\":\"Running TypeScript type check\",\"_activity\":{\"kind\":\"shell\",\"title\":\"Running TypeScript type check\",\"summary\":\"Checking the project for TypeScript errors\"}}; shell {\"command\":\"agent-reach doctor --json\",\"purpose\":\"检查 Agent Reach 可用状态\",\"_activity\":{\"kind\":\"shell\",\"title\":\"检查 Agent Reach 可用状态\"}}; read {\"path\":\"src/agent/runner.ts\",\"_activity\":{\"kind\":\"file\",\"title\":\"Reading agent runner implementation\",\"summary\":\"Inspecting how Pixiu handles tool events\"}}.",
  "Only produce the final user-facing answer when the task is complete.",
  "Every final answer must begin with `FINAL:`. Text that does not begin with `FINAL:` is treated as a draft once; after one continuation request, the runner may use the next text response as the answer to avoid an endless loop.",
].join("\n")

function parseFinalAnswer(text: string) {
  const trimmed = text.trim()
  const match = trimmed.match(/(?:^|\n)(?:\*\*)?FINAL\s*[:：](?:\*\*)?\s*([\s\S]*)$/i)
  return match ? match[1]?.trimStart() ?? "" : undefined
}

function mergeSessionSummary(existing: string | undefined, next: string) {
  const current = existing?.trim()
  const incoming = next.trim()
  if (!current) return incoming
  if (!incoming) return current
  if (incoming.includes(current)) return incoming
  if (current.includes(incoming)) return current
  return `${current}\n\n${incoming}`
}

function isAbortError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const item = error as { name?: unknown; code?: unknown }
  return item.name === "AbortError" || item.code === "ABORT_ERR" || item.code === "ERR_ABORTED"
}

function estimateLLMInputTokens(messages: LLMMessage[]) {
  return messages.reduce((total, message) => {
    const toolCallTokens = message.toolCalls?.reduce((sum, call) => sum + approximateTokens(`${call.name} ${JSON.stringify(call.input)}`), 0) ?? 0
    return total + approximateTokens(`${message.role}\n${message.content}`) + toolCallTokens
  }, 0)
}

function todoUpdatedEvent(sessionId: string, ok: boolean, metadata: JsonObject | undefined): Extract<AgentEvent, { type: "todo_updated" }> | undefined {
  if (!ok) return undefined
  const todos = todosFromMetadata(metadata)
  if (!todos) return undefined
  const currentTodo = todos.find((todo) => todo.status === "in_progress")
  return {
    type: "todo_updated",
    sessionId,
    todos,
    ...(currentTodo ? { currentTodoId: currentTodo.id } : {}),
  }
}

function todosFromMetadata(metadata: JsonObject | undefined): TodoItem[] | undefined {
  const value = metadata?.todos
  if (!Array.isArray(value)) return undefined
  const todos: TodoItem[] = []
  for (const item of value) {
    const todo = todoFromJson(item)
    if (!todo) return undefined
    todos.push(todo)
  }
  return todos
}

function todoFromJson(value: JsonValue): TodoItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const id = value.id
  const content = value.content
  const status = value.status
  const priority = value.priority
  if (typeof id !== "string" || typeof content !== "string") return undefined
  if (!isTodoStatus(status) || !isTodoPriority(priority)) return undefined
  return { id, content, status, priority }
}

function isTodoStatus(value: JsonValue | undefined): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled"
}

function isTodoPriority(value: JsonValue | undefined): value is TodoPriority {
  return value === "high" || value === "medium" || value === "low"
}

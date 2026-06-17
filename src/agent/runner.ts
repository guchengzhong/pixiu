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

        for (const call of toolCalls) {
          const signal = input.signal ?? this.options.signal
          if (signal?.aborted) {
            yield { type: "finish", reason: "cancelled", sessionId: session.id }
            return
          }
          const baseToolContext = this.options.toolContextForSession?.(session) ?? this.options.toolContext
          const toolContext = {
            ...baseToolContext,
            sessionId: session.id,
          }
          const result = await this.options.tools.execute(
            call.name,
            stripToolActivityInput(call.input),
            signal ? { ...toolContext, signal } : toolContext,
          )
          if (signal?.aborted) {
            yield { type: "finish", reason: "cancelled", sessionId: session.id }
            return
          }
          await this.options.sessions.appendMessage({
            sessionId: session.id,
            role: "tool",
            parts: [{ type: "tool_result", toolCallId: call.id, name: call.name, result }],
          })
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
}

const AGENT_COMPLETION_PROTOCOL = [
  "Completion protocol:",
  "If the user asks for work that requires files, commands, live data, or other external state, call tools instead of describing what you will do.",
  "When calling a tool, you may include a Pixiu-only `_activity` object to describe the concise user-visible intent of that tool call. `_activity.title` should describe what you are trying to do, not the raw command. Keep it factual, omit secrets, and use it only when it improves readability. The runtime strips `_activity` before executing tools.",
  "Examples: shell {\"command\":\"npm run typecheck\",\"_activity\":{\"kind\":\"shell\",\"title\":\"Running TypeScript type check\",\"summary\":\"Checking the project for TypeScript errors\"}}; read {\"path\":\"src/agent/runner.ts\",\"_activity\":{\"kind\":\"file\",\"title\":\"Reading agent runner implementation\",\"summary\":\"Inspecting how Pixiu handles tool events\"}}.",
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

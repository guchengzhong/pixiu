import { createID } from "../shared/id"
import { formatError } from "../shared/errors"
import type { LLMClient, LLMMessage } from "../llm/types"
import type { SessionRecord, SessionStore } from "../session/types"
import { toLLMMessages } from "../session/format"
import type { ToolContext } from "../tools/types"
import type { ToolRegistry } from "../tools/registry"
import type { AgentEvent } from "./events"
import { compactMessages } from "./compaction"
import type { JsonObject } from "../shared/json"

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
      const compacted = this.options.compaction ? compactMessages(storedMessages, this.options.compaction) : { messages: storedMessages }
      if (compacted.summary) await this.options.sessions.updateSession(session.id, { summary: compacted.summary })

      const messages: LLMMessage[] = [
        {
          role: "system",
          content: [this.options.systemPrompt, AGENT_COMPLETION_PROTOCOL, compacted.summary ? `Conversation summary:\n${compacted.summary}` : ""]
            .filter(Boolean)
            .join("\n\n"),
        },
        ...toLLMMessages(compacted.messages),
        ...continuationMessages,
      ]

      const toolCalls = []
      let assistantText = ""
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
          if (event.type === "tool_call") {
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
            ...toolCalls.map((call) => ({ type: "tool_call" as const, id: call.id, name: call.name, input: call.input })),
          ],
        })
        continuationMessages.length = 0
        draftContinuations = 0

        for (const call of toolCalls) {
          const baseToolContext = this.options.toolContextForSession?.(session) ?? this.options.toolContext
          const toolContext = {
            ...baseToolContext,
            sessionId: session.id,
          }
          const signal = input.signal ?? this.options.signal
          const result = await this.options.tools.execute(
            call.name,
            call.input,
            signal ? { ...toolContext, signal } : toolContext,
          )
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
  "Only produce the final user-facing answer when the task is complete.",
  "Every final answer must begin with `FINAL:`. Text that does not begin with `FINAL:` is treated as a draft once; after one continuation request, the runner may use the next text response as the answer to avoid an endless loop.",
].join("\n")

function parseFinalAnswer(text: string) {
  const trimmed = text.trim()
  const match = trimmed.match(/(?:^|\n)(?:\*\*)?FINAL\s*[:：](?:\*\*)?\s*([\s\S]*)$/i)
  return match ? match[1]?.trimStart() ?? "" : undefined
}

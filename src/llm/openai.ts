import { createID } from "../shared/id"
import { MinicodeError } from "../shared/errors"
import type { JsonObject } from "../shared/json"
import { withSignal } from "../shared/fetch"
import type { LLMClient, LLMMessage, LLMStreamEvent, LLMStreamInput, LLMToolCall } from "./types"

export type OpenAICompatibleOptions = {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

function toOpenAITools(input: LLMStreamInput) {
  return input.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function toOpenAIMessages(messages: LLMMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      }
    }
    return {
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input),
        },
      })),
    }
  })
}

function parseToolArguments(raw: string): JsonObject {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return { _raw: raw }
  }
}

export class OpenAICompatibleClient implements LLMClient {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  async *stream(input: LLMStreamInput, signal?: AbortSignal): AsyncIterable<LLMStreamEvent> {
    const url = `${this.options.baseURL.replace(/\/$/, "")}/chat/completions`
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.options.headers,
    }
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`

    const response = await fetch(url, withSignal({
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.model,
        messages: toOpenAIMessages(input.messages),
        tools: toOpenAITools(input),
        tool_choice:
          typeof input.toolChoice === "object"
            ? { type: "function", function: { name: input.toolChoice.name } }
            : input.toolChoice,
        temperature: input.temperature,
        stream: true,
      }),
    }, signal))

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "")
      yield {
        type: "error",
        code: "LLM_REQUEST_FAILED",
        error: `LLM request failed (${response.status}): ${body.slice(0, 800)}`,
      }
      yield { type: "finish", reason: "error" }
      return
    }

    let text = ""
    let started = false
    const pendingTools = new Map<number, { id?: string; name?: string; args: string }>()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const data = line.slice("data:".length).trim()
        if (!data || data === "[DONE]") continue
        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          yield { type: "error", error: `Invalid provider stream chunk: ${data.slice(0, 120)}` }
          continue
        }

        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta?.reasoning_content) {
          yield { type: "reasoning_delta", text: String(delta.reasoning_content) }
        }
        if (delta?.content) {
          if (!started) {
            started = true
            yield { type: "text_start" }
          }
          text += String(delta.content)
          yield { type: "text_delta", text: String(delta.content) }
        }
        for (const toolDelta of delta?.tool_calls ?? []) {
          const index = Number(toolDelta.index ?? 0)
          const current = pendingTools.get(index) ?? { args: "" }
          if (typeof toolDelta.id === "string" && toolDelta.id) current.id = toolDelta.id
          if (typeof toolDelta.function?.name === "string" && toolDelta.function.name) current.name = toolDelta.function.name
          current.args += toolDelta.function?.arguments ?? ""
          pendingTools.set(index, current)
        }
        if (choice?.finish_reason) {
          if (started) yield { type: "text_end", text }
          for (const tool of pendingTools.values()) {
            if (!tool.name) continue
            const call: LLMToolCall = {
              id: tool.id ?? createID("toolcall"),
              name: tool.name,
              input: parseToolArguments(tool.args),
            }
            yield { type: "tool_call", call }
          }
          yield { type: "finish", reason: String(choice.finish_reason) }
        }
      }
    }
  }
}

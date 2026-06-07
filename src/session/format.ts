import type { LLMMessage, LLMToolCall } from "../llm/types"
import type { SessionMessage } from "./types"

export function toLLMMessages(messages: SessionMessage[]): LLMMessage[] {
  const output: LLMMessage[] = []
  for (const message of messages) {
    const text = message.parts
      .filter((part) => part.type === "text" || part.type === "reasoning" || part.type === "error")
      .map((part) => ("text" in part ? part.text : part.message))
      .join("\n")
    const toolCalls = message.parts
      .filter((part) => part.type === "tool_call")
      .map((part) => ({ id: part.id, name: part.name, input: part.input }) satisfies LLMToolCall)
    const toolResult = message.parts.find((part) => part.type === "tool_result")
    const llmMessage: LLMMessage = {
      role: message.role,
      content: toolResult ? JSON.stringify(toolResult.result) : text,
    }
    if (toolResult?.toolCallId) llmMessage.toolCallId = toolResult.toolCallId
    if (toolCalls.length) llmMessage.toolCalls = toolCalls
    output.push(llmMessage)
  }
  return output
}

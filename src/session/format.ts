import type { LLMMessage, LLMToolCall } from "../llm/types"
import type { MessagePart, SessionMessage } from "./types"

// Converts stored session messages into LLM messages while enforcing the OpenAI/DeepSeek
// tool-call contract: every assistant `tool_calls` entry must be answered by a `tool`
// message with a matching id, appearing immediately after that assistant message.
//
// Stored history can violate this — e.g. concurrent runs interleaving writes, or a run
// aborted between persisting an assistant tool_call and its result. Rather than faithfully
// reproducing an illegal sequence (which makes providers reject the whole request), we
// sanitize and re-pair here:
//   - drop tool_calls that have no matching tool result (orphans);
//   - drop tool messages that have no matching assistant tool_call (orphans);
//   - emit each surviving tool result immediately after the assistant that declared it,
//     so interleaved `assistant[X], assistant[Y], tool(X), tool(Y)` becomes
//     `assistant[X], tool(X), assistant[Y], tool(Y)`.
export function toLLMMessages(messages: SessionMessage[]): LLMMessage[] {
  const resultsById = new Map<string, MessagePart & { type: "tool_result" }>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_result" && part.toolCallId) resultsById.set(part.toolCallId, part)
    }
  }

  const output: LLMMessage[] = []
  const consumedResults = new Set<string>()

  for (const message of messages) {
    // Tool results are emitted while pairing with their assistant, never standalone.
    if (message.role === "tool") continue

    const text = textFromParts(message.parts)

    if (message.role !== "assistant") {
      output.push({ role: message.role, content: text })
      continue
    }

    // Keep only tool_calls that actually have a result available to pair with.
    const pairedCalls = message.parts
      .filter((part): part is MessagePart & { type: "tool_call" } => part.type === "tool_call")
      .filter((part) => resultsById.has(part.id) && !consumedResults.has(part.id))
      .map((part) => ({ id: part.id, name: part.name, input: part.input }) satisfies LLMToolCall)

    if (!pairedCalls.length) {
      // No answerable tool call. Skip empty shells left behind by orphaned calls.
      if (text) output.push({ role: "assistant", content: text })
      continue
    }

    const assistantMessage: LLMMessage = { role: "assistant", content: text, toolCalls: pairedCalls }
    output.push(assistantMessage)
    for (const call of pairedCalls) {
      const result = resultsById.get(call.id)!
      consumedResults.add(call.id)
      output.push({ role: "tool", content: JSON.stringify(result.result), toolCallId: call.id })
    }
  }

  return output
}

function textFromParts(parts: MessagePart[]) {
  return parts
    .filter((part) => part.type === "text" || part.type === "reasoning" || part.type === "error")
    .map((part) => ("text" in part ? part.text : part.message))
    .join("\n")
}

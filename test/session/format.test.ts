import { describe, expect, test } from "bun:test"

import { toLLMMessages } from "../../src/session/format"
import type { MessagePart, SessionMessage } from "../../src/session/types"

let counter = 0
function msg(role: SessionMessage["role"], parts: MessagePart[]): SessionMessage {
  counter += 1
  return { id: `m${counter}`, sessionId: "s", role, createdAt: "2026-07-08T00:00:00.000Z", parts }
}

function toolCall(id: string, name = "shell") {
  return { type: "tool_call" as const, id, name, input: { command: `run ${id}` } }
}

function toolResult(id: string, name = "shell") {
  return { type: "tool_result" as const, toolCallId: id, name, result: { ok: true, content: id } }
}

// Every assistant with tool_calls must be immediately followed by exactly one tool
// message per call id, in order — the OpenAI/DeepSeek contract.
function assertValidToolPairing(messages: ReturnType<typeof toLLMMessages>) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    if (message.role !== "assistant" || !message.toolCalls?.length) continue
    for (let c = 0; c < message.toolCalls.length; c += 1) {
      const follower = messages[i + 1 + c]
      expect(follower?.role).toBe("tool")
      expect(follower?.toolCallId).toBe(message.toolCalls[c]!.id)
    }
  }
  // No tool message without a directly-preceding assistant tool_call for its id.
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.role !== "tool") continue
    const id = messages[i]!.toolCallId
    let paired = false
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = messages[j]!
      if (prev.role === "assistant" && prev.toolCalls?.some((call) => call.id === id)) { paired = true; break }
      if (prev.role !== "tool") break
    }
    expect(paired).toBe(true)
  }
}

describe("toLLMMessages sanitization", () => {
  test("passes through a well-formed conversation", () => {
    const out = toLLMMessages([
      msg("user", [{ type: "text", text: "hi" }]),
      msg("assistant", [{ type: "text", text: "hello" }]),
    ])
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ])
  })

  test("drops an assistant tool_call that has no matching result", () => {
    const out = toLLMMessages([
      msg("user", [{ type: "text", text: "date?" }]),
      msg("assistant", [{ type: "text", text: "checking" }, toolCall("a")]),
      // no tool result for "a"
      msg("user", [{ type: "text", text: "still there?" }]),
    ])
    assertValidToolPairing(out)
    expect(out.some((m) => m.toolCalls?.length)).toBe(false)
    expect(out.find((m) => m.role === "assistant")?.content).toBe("checking")
  })

  test("drops an orphaned tool message with no preceding tool_call", () => {
    const out = toLLMMessages([
      msg("user", [{ type: "text", text: "hi" }]),
      msg("tool", [toolResult("ghost")]),
      msg("assistant", [{ type: "text", text: "ok" }]),
    ])
    assertValidToolPairing(out)
    expect(out.some((m) => m.role === "tool")).toBe(false)
  })

  test("reorders interleaved assistant tool_calls so each is followed by its result", () => {
    const out = toLLMMessages([
      msg("user", [{ type: "text", text: "go" }]),
      msg("assistant", [{ type: "text", text: "first" }, toolCall("x")]),
      msg("assistant", [toolCall("y")]),
      msg("tool", [toolResult("x")]),
      msg("tool", [toolResult("y")]),
    ])
    assertValidToolPairing(out)
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"])
    expect(out[1]?.toolCalls?.[0]?.id).toBe("x")
    expect(out[2]?.toolCallId).toBe("x")
    expect(out[3]?.toolCalls?.[0]?.id).toBe("y")
    expect(out[4]?.toolCallId).toBe("y")
  })
})

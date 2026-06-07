import { describe, expect, test } from "bun:test"

import { compactMessages } from "../../src/agent/compaction"
import type { SessionMessage } from "../../src/session/types"

describe("compaction", () => {
  test("summarizes older messages and keeps recent turns", () => {
    const messages: SessionMessage[] = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      sessionId: "s",
      role: "user",
      createdAt: new Date(index).toISOString(),
      parts: [{ type: "text", text: "x".repeat(200) }],
    }))
    const result = compactMessages(messages, { maxApproxTokens: 100, keepRecentMessages: 2 })
    expect(result.messages.length).toBe(2)
    expect(result.summary).toContain("Compacted 6 older messages")
  })
})

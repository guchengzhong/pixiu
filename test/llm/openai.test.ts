import { describe, expect, test } from "bun:test"

import { OpenAICompatibleClient } from "../../src/llm/openai"

describe("OpenAI-compatible LLM client", () => {
  test("normalizes streaming text events", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "llo" } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      const client = new OpenAICompatibleClient({ baseURL: `http://127.0.0.1:${server.port}`, apiKey: "ok" })
      const events = []
      for await (const event of client.stream({ model: "fake", messages: [{ role: "user", content: "hi" }] })) {
        events.push(event)
      }
      expect(events.map((event) => event.type)).toEqual(["text_start", "text_delta", "text_delta", "text_end", "finish"])
      expect(events.find((event) => event.type === "text_end")).toMatchObject({ text: "hello" })
    } finally {
      server.stop(true)
    }
  })

  test("returns structured error events on provider failure", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: "bad key" }), { status: 401 })
      },
    })
    try {
      const client = new OpenAICompatibleClient({ baseURL: `http://127.0.0.1:${server.port}`, apiKey: "bad" })
      const events = []
      for await (const event of client.stream({ model: "fake", messages: [{ role: "user", content: "hi" }] })) {
        events.push(event)
      }
      expect(events[0]).toMatchObject({ type: "error", code: "LLM_REQUEST_FAILED" })
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
    } finally {
      server.stop(true)
    }
  })
})

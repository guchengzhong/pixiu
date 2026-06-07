import { describe, expect, test } from "bun:test"

import type { AgentEvent } from "../../src/agent/events"
import { CliTraceRenderer } from "../../src/cli/trace"

function render(events: AgentEvent[], ticks?: number[]) {
  const chunks: string[] = []
  let index = 0
  const renderer = new CliTraceRenderer({
    write: (chunk) => chunks.push(chunk),
    now: () => ticks?.[index++] ?? 0,
  })
  for (const event of events) renderer.handle(event)
  renderer.finish()
  return chunks.join("")
}

describe("CliTraceRenderer", () => {
  test("renders shell activity before the final answer", () => {
    const output = render(
      [
        { type: "tool_call", id: "call_1", name: "shell", input: { command: "curl -s http://wttr.in/Wuhan" } },
        {
          type: "tool_result",
          id: "call_1",
          name: "shell",
          ok: true,
          content: "exitCode: 0\nSunny +32C",
          metadata: { exitCode: 0, timedOut: false },
        },
        { type: "llm_text_delta", text: "done" },
      ],
      [1000, 1420],
    )

    expect(output).toContain("tool bash curl -s http://wttr.in/Wuhan")
    expect(output).toContain("  ok exit=0 420 ms")
    expect(output).toContain("\n\ndone\n")
  })

  test("previews failed tool output and redacts secrets", () => {
    const output = render(
      [
        {
          type: "tool_call",
          id: "call_1",
          name: "shell",
          input: {
            command:
              "MINICODE_API_KEY=sk-1234567890abcdef curl 'https://api.example.test/weather?api_key=very-secret'",
          },
        },
        {
          type: "tool_result",
          id: "call_1",
          name: "shell",
          ok: false,
          content: "exitCode: 1\nrequest failed for sk-abcdef1234567890 and api_key=very-secret",
          metadata: { exitCode: 1, timedOut: false },
        },
      ],
      [0, 50],
    )

    expect(output).toContain("MINICODE_API_KEY=[redacted]")
    expect(output).toContain("api_key=[redacted]")
    expect(output).toContain("sk-[redacted]")
    expect(output).toContain("  fail exit=1 50 ms")
    expect(output).not.toContain("very-secret")
    expect(output).not.toContain("sk-1234567890abcdef")
    expect(output).not.toContain("sk-abcdef1234567890")
  })

  test("renders compact labels for common file tools", () => {
    const output = render([
      { type: "tool_call", id: "read_1", name: "read", input: { path: "docs/usage.md" } },
      { type: "tool_result", id: "read_1", name: "read", ok: true, content: "hello", metadata: { path: "docs/usage.md" } },
      { type: "tool_call", id: "grep_1", name: "grep", input: { query: "weather", path: "docs" } },
      { type: "tool_result", id: "grep_1", name: "grep", ok: true, content: "No matches" },
      { type: "tool_call", id: "write_1", name: "write", input: { path: "docs/weather.md", content: "# Weather" } },
      { type: "tool_result", id: "write_1", name: "write", ok: true, content: "Changed docs/weather.md" },
    ])

    expect(output).toContain("tool read docs/usage.md")
    expect(output).toContain("tool grep \"weather\" in docs")
    expect(output).toContain("tool write docs/weather.md")
  })
})

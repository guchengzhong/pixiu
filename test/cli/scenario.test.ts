import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { AgentEvent } from "../../src/agent/events"
import type { Match } from "../harness/llm-server"
import { expectExit, parseJsonEvents, withMinicodeFixture } from "../harness/minicode-process"
import { hang, requestBodyIncludes, requestHasToolResult, runScenario, streamError, text, tool } from "../harness/scenario"

describe("scenario harness", () => {
  test("runs a weather-style task with traces and workspace assertions", async () => {
    await runScenario({
      name: "weather markdown trace",
      prompt: "查询武汉洪山区明天天气，并整理到 weather.md",
      replies: [
        tool("shell", { command: "printf '武汉洪山区 明天 晴 27-31C\\n'" }),
        tool("write", { path: "weather.md", content: "# 武汉洪山区天气\n\n明天晴，27-31C。\n" }),
        text("FINAL: 已写入 weather.md"),
      ],
      run: { yes: true },
      expect: {
        exitCode: 0,
        timedOut: false,
        stdoutContains: ["tool bash printf", "tool write weather.md", "已写入 weather.md"],
        stdoutNotContains: ['{"type":"tool_call"'],
        stderr: "",
        workspaceFiles: {
          "weather.md": /武汉洪山区天气[\s\S]*27-31C/,
        },
        llmRequests: {
          count: 3,
          contains: ["Completion protocol", "武汉洪山区"],
          toolsInclude: ["shell", "write"],
        },
      },
    })
  })

  test("matches queued replies against prior tool results", async () => {
    await runScenario({
      name: "matched tool continuation",
      prompt: "请先列一个 todo，再总结",
      replies: [
        tool("todo", { items: ["inspect workspace", "write summary"] }),
        text("FINAL: matched after todo", { match: requestHasToolResult() }),
      ],
      run: { json: true, yes: true },
      expect: {
        exitCode: 0,
        timedOut: false,
        eventTypes: ["session_created", "tool_call", "tool_result", "llm_text_delta", "message", "finish"],
        stdoutContains: ["matched after todo"],
        llmRequests: {
          count: 2,
          toolsInclude: ["todo"],
        },
      },
    })
  })

  test("advertises local skills and lets the agent load one", async () => {
    await withMinicodeFixture(async ({ llm, projectDir, run }) => {
      await mkdir(join(projectDir, ".minicode", "skills", "demo", "references"), { recursive: true })
      await writeFile(
        join(projectDir, ".minicode", "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Use for demo workflows\n---\nAlways mention the demo workflow.",
        "utf8",
      )
      await writeFile(join(projectDir, ".minicode", "skills", "demo", "references", "note.md"), "Demo reference note", "utf8")

      llm.tool("skill", { name: "demo" })
      llm.text("FINAL: 已加载 demo skill", { match: requestHasToolResult("skill") })

      const result = await run("请使用 demo skill 回答", { yes: true })
      expectExit(result, 0, "skill scenario")
      expect(result.stdout).toContain("tool skill \"demo\"")
      expect(result.stdout).toContain("已加载 demo skill")

      const requestText = llm.inputs().map((input) => JSON.stringify(input)).join("\n")
      expect(requestText).toContain("Available skills:")
      expect(requestText).toContain("demo: Use for demo workflows")
    })
  })

  test("surfaces provider stream parse errors without hanging", async () => {
    await runScenario({
      name: "stream parse error",
      prompt: "触发一个 provider 流错误",
      replies: [streamError()],
      run: { json: true, timeoutMs: 3_000 },
      expect: {
        exitCode: 2,
        timedOut: false,
        eventTypes: ["session_created", "error", "finish"],
        stdoutContains: ["Invalid provider stream chunk"],
      },
    })
  })

  test("kills hanging provider responses at the subprocess boundary", async () => {
    await runScenario({
      name: "hanging provider timeout",
      prompt: "触发一个 provider hang",
      replies: [hang()],
      run: { json: true, timeoutMs: 500 },
      expect: {
        exitCode: -1,
        timedOut: true,
      },
    })
  })

  test("keeps concurrent run workspaces isolated", async () => {
    await withMinicodeFixture(async ({ llm, projectDir, run }) => {
      const afterToolWith = (value: string): Match => (hit) => requestHasToolResult()(hit) && requestBodyIncludes(value)(hit)

      llm.tool("write", { path: "same.md", content: "alpha-content-001" }, { match: requestBodyIncludes("parallel alpha") })
      llm.tool("write", { path: "same.md", content: "beta-content-002" }, { match: requestBodyIncludes("parallel beta") })
      llm.text("FINAL: alpha done", { match: afterToolWith("alpha-content-001") })
      llm.text("FINAL: beta done", { match: afterToolWith("beta-content-002") })

      const [one, two] = await Promise.all([
        run("parallel alpha", { json: true, yes: true }),
        run("parallel beta", { json: true, yes: true }),
      ])

      expectExit(one, 0, "parallel alpha")
      expectExit(two, 0, "parallel beta")
      const oneSession = sessionIdFrom(parseJsonEvents(one.stdout))
      const twoSession = sessionIdFrom(parseJsonEvents(two.stdout))

      expect(oneSession).not.toBe(twoSession)
      expect(await readFile(join(projectDir, "workspace", oneSession, "same.md"), "utf8")).toBe("alpha-content-001")
      expect(await readFile(join(projectDir, "workspace", twoSession, "same.md"), "utf8")).toBe("beta-content-002")
    })
  })
})

function sessionIdFrom(events: AgentEvent[]) {
  const event = events.find((item) => item.type === "session_created")
  if (!event) throw new Error("missing session_created event")
  return event.sessionId
}

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { renderReport, runLiveSmoke } from "../../scripts/live-smoke"
import { withMinicodeFixture } from "../harness/minicode-process"

describe("live smoke script", () => {
  test("runs all smoke cases against the fake provider and writes a report", async () => {
    await withMinicodeFixture(async ({ llm, projectDir }) => {
      const previous = process.env.MINICODE_TEST_API_KEY
      process.env.MINICODE_TEST_API_KEY = "test-key"
      try {
        llm.text("FINAL: plain text smoke ok")
        llm.tool("write", { path: "live-smoke-tool.md", content: "# Live smoke\n\nLive smoke tool-call smoke\n" })
        llm.text("FINAL: wrote live-smoke-tool.md")
        llm.tool("shell", {
          command:
            "mkdir -p .minicode/tmp && printf 'Command: local shell smoke\\nSource: fake provider\\nAccess time: 2026-06-05T00:00:00Z\\n' > .minicode/tmp/live-smoke-evidence.md",
        })
        llm.text("FINAL: wrote .minicode/tmp/live-smoke-evidence.md")

        const report = await runLiveSmoke({ cwd: projectDir, reportPath: "live-smoke-report.md" })

        expect(report.ok).toBe(true)
        expect(report.cases.map((item) => item.name)).toEqual(["plain-text", "tool-call", "temporary-script"])
        expect(report.cases[1]?.producedFiles).toEqual(["live-smoke-tool.md"])
        expect(report.cases[2]?.toolCalls).toEqual(["shell"])
        const content = await readFile(join(projectDir, "live-smoke-report.md"), "utf8")
        expect(content).toContain("Status: PASS")
        expect(content).toContain("Provider:")
        expect(content).toContain("Tool calls: shell")
      } finally {
        restoreEnv("MINICODE_TEST_API_KEY", previous)
      }
    })
  })

  test("reports smoke verification failures without real provider access", async () => {
    await withMinicodeFixture(async ({ llm, projectDir }) => {
      const previous = process.env.MINICODE_TEST_API_KEY
      process.env.MINICODE_TEST_API_KEY = "test-key"
      try {
        llm.text("FINAL: plain text smoke ok")
        llm.text("FINAL: skipped tool work")
        llm.text("FINAL: skipped shell work")

        const report = await runLiveSmoke({ cwd: projectDir, reportPath: "failed-live-smoke-report.md" })

        expect(report.ok).toBe(false)
        expect(report.cases[0]?.ok).toBe(true)
        expect(report.cases[1]?.ok).toBe(false)
        expect(report.cases[1]?.failureReason).toContain("live-smoke-tool.md")
        const content = await readFile(join(projectDir, "failed-live-smoke-report.md"), "utf8")
        expect(content).toContain("Status: FAIL")
        expect(content).toContain("Failure:")
      } finally {
        restoreEnv("MINICODE_TEST_API_KEY", previous)
      }
    })
  })

  test("times out hanging fake provider smoke cases", async () => {
    await withMinicodeFixture(async ({ llm, projectDir }) => {
      const previous = process.env.MINICODE_TEST_API_KEY
      process.env.MINICODE_TEST_API_KEY = "test-key"
      try {
        llm.hang()

        const report = await runLiveSmoke({ cwd: projectDir, reportPath: "timeout-live-smoke-report.md", timeoutMs: 50 })

        expect(report.ok).toBe(false)
        expect(report.cases[0]?.ok).toBe(false)
        expect(report.cases[0]?.failureReason).toContain("timed out")
        const content = await readFile(join(projectDir, "timeout-live-smoke-report.md"), "utf8")
        expect(content).toContain("timed out")
      } finally {
        restoreEnv("MINICODE_TEST_API_KEY", previous)
      }
    })
  })

  test("redacts secrets in smoke reports", () => {
    const report = renderReport({
      ok: false,
      provider: { baseURL: "https://api.example.test/v1?api_key=very-secret", model: "test-model", apiKeyEnv: "MINICODE_API_KEY" },
      cwd: "/tmp/project",
      reportPath: "/tmp/report.md",
      cases: [
        {
          name: "secret-failure",
          ok: false,
          toolCalls: [],
          producedFiles: [],
          failureReason: "request failed with MINICODE_API_KEY=sk-1234567890abcdef and token=very-secret",
        },
      ],
    })

    expect(report).toContain("MINICODE_API_KEY=[redacted]")
    expect(report).toContain("api_key=[redacted]")
    expect(report).toContain("token=[redacted]")
    expect(report).not.toContain("very-secret")
    expect(report).not.toContain("sk-1234567890abcdef")
  })

  test("fails fast when the configured provider API key is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-live-smoke-missing-key-"))
    await writeFile(
      join(root, "minicode.jsonc"),
      JSON.stringify(
        {
          model: "openai-compatible/test-model",
          providers: {
            "openai-compatible": {
              type: "openai-compatible",
              baseURL: "http://127.0.0.1/unused/v1",
              apiKeyEnv: "MINICODE_TEST_MISSING_LIVE_KEY",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    )

    await expect(runLiveSmoke({ cwd: root, reportPath: "missing-key-report.md" })).rejects.toThrow("MINICODE_TEST_MISSING_LIVE_KEY")
  })
})

function restoreEnv(key: string, previous: string | undefined) {
  if (previous === undefined) delete process.env[key]
  else process.env[key] = previous
}

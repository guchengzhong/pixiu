import { describe, expect, test } from "bun:test"
import { clearTerminalSequence, runCli } from "../../src/cli/index"

describe("runCli", () => {
  test("clear terminal sequence clears both viewport and scrollback by default", () => {
    expect(clearTerminalSequence()).toBe("\x1b[H\x1b[2J\x1b[3J\x1b[H")
    expect(clearTerminalSequence({ clearScrollback: false })).toBe("\x1b[H\x1b[2J\x1b[H")
  })

  test("prints help", async () => {
    const result = await runCli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Usage:")
    expect(result.output).toContain("Agent commands:")
    expect(result.output).toContain("Common options:")
    expect(result.output).toContain("pixiu run [-c|--continue] <message>")
    expect(result.output).toContain("--permission-mode")
    expect(result.output).toContain("pixiu config set <key>")
    expect(result.output).toContain("pixiu ui")
    expect(result.output).not.toContain("--mock")
    expect(result.output).not.toContain("connector")
  })

  test("reports unknown commands", async () => {
    const result = await runCli(["missing"])

    expect(result.exitCode).toBe(1)
    expect(result.error).toContain("Unknown command")
  })

  test("rejects removed mock mode", async () => {
    const result = await runCli(["run", "--mock", "hello"])

    expect(result.exitCode).toBe(1)
    expect(result.error).toContain("--mock has been removed")
  })

  test("prints ui help", async () => {
    const result = await runCli(["ui", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("pixiu ui")
    expect(result.output).toContain("--port")
    expect(result.output).toContain("2208")
  })

  test("rejects invalid ui ports", async () => {
    const result = await runCli(["ui", "--port", "nope"])

    expect(result.exitCode).toBe(1)
    expect(result.error).toContain("Invalid UI port")
  })

  test("reports occupied ui ports clearly", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") })
    try {
      const result = await runCli(["ui", "--port", String(blocker.port), "--no-open"])

      expect(result.exitCode).toBe(1)
      expect(result.error).toContain(`UI port 127.0.0.1:${blocker.port} is already in use`)
      expect(result.error).toContain("--port")
    } finally {
      blocker.stop(true)
    }
  })
})

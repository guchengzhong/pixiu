import { describe, expect, test } from "bun:test"
import { runCli } from "../../src/cli/index"

describe("runCli", () => {
  test("prints help", async () => {
    const result = await runCli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Usage:")
    expect(result.output).toContain("Agent commands:")
    expect(result.output).toContain("Common options:")
    expect(result.output).toContain("minicode run [-c|--continue] <message>")
    expect(result.output).toContain("--permission-mode")
    expect(result.output).toContain("minicode config set <key>")
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
})

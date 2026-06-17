import { describe, expect, test } from "bun:test"

import {
  CHAT_COMMANDS,
  applySlashCompletion,
  formatChatHelp,
  matchingSlashCommands,
  slashCommandNames,
} from "../../src/cli/commands"

describe("chat slash commands", () => {
  test("derives help and metadata from the same command table", () => {
    const names = slashCommandNames(CHAT_COMMANDS)
    const help = formatChatHelp(CHAT_COMMANDS)

    expect(names).toContain("clear")
    expect(names).toContain("config")
    expect(names).toContain("doctor")
    expect(help).toContain("/clear")
    expect(help).toContain("Clear the terminal screen")
    expect(help).toContain("/config")
  })

  test("matches and applies slash command completions", () => {
    expect(matchingSlashCommands("/con", CHAT_COMMANDS).map((command) => command.name)).toEqual(["/config"])
    expect(matchingSlashCommands("/do", CHAT_COMMANDS).map((command) => command.name)).toEqual(["/doctor"])
    expect(applySlashCompletion("/con", "/config")).toBe("/config")
    expect(applySlashCompletion("  /do", "/doctor")).toBe("  /doctor")
  })
})

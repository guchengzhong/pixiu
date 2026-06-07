import { describe, expect, test } from "bun:test"

import { createTerminal, displayWidth, panel, panelWidthForTerminal, renderMarkdown, stripAnsi } from "../../src/cli/terminal"

describe("terminal markdown rendering", () => {
  test("keeps markdown readable without requiring a full parser", () => {
    const terminal = createTerminal({ noColor: true, width: 80 })
    const rendered = renderMarkdown(["# Title", "", "- one", "> note", "```ts", "const x = 1", "```"].join("\n"), {
      terminal,
    })

    expect(rendered).toContain("Title")
    expect(rendered).toContain("- one")
    expect(rendered).toContain("| note")
    expect(rendered).toContain("```ts")
    expect(rendered).toContain("const x = 1")
  })
})

describe("terminal chrome", () => {
  test("uses configurable RGB accent color", () => {
    const terminal = createTerminal({ forceColor: true, width: 80, accentColor: "#3B8EEA" })

    expect(terminal.blue("x")).toContain("\x1b[38;2;59;142;234m")
    expect(terminal.accentColor).toBe("#3B8EEA")
  })

  test("keeps heavy panel within the safe terminal width", () => {
    const terminal = createTerminal({ noColor: true, width: 120 })
    const output = panel(
      "minicode v0.0.0",
      [
        ["          ████        ████", "Tips for getting started"],
        ["        ████  ██    ██  ████", "Recent activity"],
        ["", "a long recent activity title that should not push the right frame outside the terminal"],
      ],
      { terminal, width: terminal.width, dividerColumn: 36 },
    )

    for (const line of output.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(panelWidthForTerminal(terminal.width))
    }
  })

  test("colors the title without leaking color resets into the border", () => {
    const terminal = createTerminal({ forceColor: true, width: 80, accentColor: "#3B8EEA" })
    const [top = ""] = panel("minicode v0.0.0", [["", ""]], { terminal }).split("\n")

    expect(stripAnsi(top)).toMatch(/^┏━━━ minicode v0\.0\.0 .*┓$/)
    expect(top).toContain("\x1b[38;2;59;142;234m┏━━━")
    expect(top).toContain("\x1b[38;2;59;142;234m━")
  })
})

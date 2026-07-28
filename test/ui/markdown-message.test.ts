import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  MarkdownMessage,
  codeLanguageLabel,
  isExternalMarkdownLink,
  normalizeCodeForCopy,
} from "../../src/ui/client/components/MarkdownMessage"

describe("markdown message helpers", () => {
  test("marks web URLs as external without treating local links as external", () => {
    expect(isExternalMarkdownLink("https://example.com/docs")).toBe(true)
    expect(isExternalMarkdownLink("HTTP://example.com")).toBe(true)
    expect(isExternalMarkdownLink("//cdn.example.com/file.js")).toBe(true)
    expect(isExternalMarkdownLink("/docs/getting-started")).toBe(false)
    expect(isExternalMarkdownLink("#usage")).toBe(false)
    expect(isExternalMarkdownLink("mailto:hello@example.com")).toBe(false)
    expect(isExternalMarkdownLink(undefined)).toBe(false)
  })

  test("derives readable language labels from highlighted code classes", () => {
    expect(codeLanguageLabel("hljs language-ts")).toBe("TypeScript")
    expect(codeLanguageLabel("language-python hljs")).toBe("Python")
    expect(codeLanguageLabel("language-rust")).toBe("RUST")
    expect(codeLanguageLabel("hljs")).toBe("Plain text")
    expect(codeLanguageLabel(undefined)).toBe("Plain text")
  })

  test("removes only the parser-added trailing newline when copying code", () => {
    expect(normalizeCodeForCopy("const ready = true\n")).toBe("const ready = true")
    expect(normalizeCodeForCopy("line one\n\n")).toBe("line one\n")
    expect(normalizeCodeForCopy("no newline")).toBe("no newline")
  })

  test("renders remote images as inert text and keeps unsafe markup inert", () => {
    const html = renderToStaticMarkup(createElement(MarkdownMessage, {
      content: [
        "![Architecture](https://images.example.test/diagram.png)",
        '<img src="https://tracker.example.test/pixel.png" alt="Tracker">',
        "![Unsafe](javascript:alert(1))",
        "[Unsafe link](javascript:alert(1))",
      ].join("\n\n"),
    }))

    expect(html).not.toContain("<img")
    expect(html).not.toContain("tracker.example.test")
    expect(html).not.toContain("javascript:")
    expect(html).toContain("Architecture (https://images.example.test/diagram.png)")
    expect(html).toContain("Unsafe")
  })
})

import { describe, expect, test } from "bun:test"

import { defaultConfig } from "../../src/config/defaults"
import { createBuiltinTools } from "../../src/tools/builtin"

describe("default agent prompt", () => {
  test("guides non-trivial task progress through todowrite without pressuring simple tasks", () => {
    const prompt = defaultConfig.agents.default.systemPrompt ?? ""

    expect(prompt).toContain("Track execution progress with todowrite for non-trivial work")
    expect(prompt).toContain("3+ steps")
    expect(prompt).toContain("multi-file changes")
    expect(prompt).toContain("tests/typecheck/build")
    expect(prompt).toContain("explicit user checklist")
    expect(prompt).toContain("Do not use todowrite for simple factual Q&A")
    expect(prompt).toContain("one-step explanations")
    expect(prompt).toContain("short translation/polish")
    expect(prompt).toContain("complete latest todo snapshot")
    expect(prompt).toContain("keep at most one in_progress item")
    expect(prompt).toContain("mark completed only after the needed implementation and verification are done")
    expect(prompt).toContain("not hidden reasoning")
  })

  test("keeps legacy todo available while preferring todowrite", () => {
    const tools = defaultConfig.agents.default.tools
    const builtins = createBuiltinTools()
    const todo = builtins.find((tool) => tool.name === "todo")
    const todowrite = builtins.find((tool) => tool.name === "todowrite")

    expect(tools).toContain("todowrite")
    expect(tools).toContain("todo")
    expect(tools.indexOf("todowrite")).toBeLessThan(tools.indexOf("todo"))
    expect(todo?.description).toContain("Legacy compatibility")
    expect(todo?.description).toContain("Prefer todowrite")
    expect(todowrite?.description).toContain("non-trivial task progress")
    expect(todowrite?.description).toContain("avoid for simple Q&A")
  })
})

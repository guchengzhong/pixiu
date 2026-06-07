import { describe, expect, test } from "bun:test"
import { createID } from "../../src/shared/id"

describe("createID", () => {
  test("creates prefixed unique ids", () => {
    const first = createID("run")
    const second = createID("run")

    expect(first.startsWith("run_")).toBe(true)
    expect(second.startsWith("run_")).toBe(true)
    expect(first).not.toBe(second)
  })
})

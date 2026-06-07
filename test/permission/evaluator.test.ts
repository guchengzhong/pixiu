import { describe, expect, test } from "bun:test"

import { evaluatePermission, StaticPermissionManager } from "../../src/permission/evaluator"

describe("permission evaluator", () => {
  test("deny rule blocks matching tool", () => {
    const decision = evaluatePermission({ tool: "shell", input: {}, cwd: "/" }, [{ tool: "shell", action: "deny" }])
    expect(decision.action).toBe("deny")
    expect(decision.rule).toMatchObject({ index: 0, tool: "shell", action: "deny" })
    expect(decision.reason).toContain("rule #0")
  })

  test("ask rule denies in non-interactive mode", async () => {
    const manager = new StaticPermissionManager([{ tool: "write", action: "ask" }], { nonInteractive: true })
    const decision = await manager.check({ tool: "write", input: {}, cwd: "/" })
    expect(decision.action).toBe("deny")
    expect(decision.originalAction).toBe("ask")
    expect(decision.reason).toContain("non-interactive")
  })

  test("auto approve turns ask into allow", async () => {
    const manager = new StaticPermissionManager([{ tool: "write", action: "ask" }], { nonInteractive: true, autoApprove: true })
    const decision = await manager.check({ tool: "write", input: {}, cwd: "/" })
    expect(decision.action).toBe("allow")
    expect(decision.originalAction).toBe("ask")
    expect(decision.reason).toContain("auto-approved")
  })

  test("acceptEdits allows edit tools while leaving shell ask rules intact", async () => {
    const manager = new StaticPermissionManager(
      [
        { tool: "write", action: "ask" },
        { tool: "shell", action: "ask" },
      ],
      { nonInteractive: true, permissionMode: "acceptEdits" },
    )

    const write = await manager.check({ tool: "write", input: {}, cwd: "/" })
    const shell = await manager.check({ tool: "shell", input: {}, cwd: "/" })

    expect(write.action).toBe("allow")
    expect(write.reason).toContain("acceptEdits")
    expect(shell.action).toBe("deny")
    expect(shell.reason).toContain("non-interactive")
  })

  test("plan mode denies non-read tools", async () => {
    const manager = new StaticPermissionManager(
      [
        { tool: "read", action: "allow" },
        { tool: "write", action: "ask" },
      ],
      { nonInteractive: true, permissionMode: "plan" },
    )

    const read = await manager.check({ tool: "read", input: {}, cwd: "/" })
    const write = await manager.check({ tool: "write", input: {}, cwd: "/" })

    expect(read.action).toBe("allow")
    expect(write.action).toBe("deny")
    expect(write.reason).toContain("permission mode plan")
  })

  test("bypassPermissions allows deny rules", async () => {
    const manager = new StaticPermissionManager([{ tool: "shell", action: "deny" }], {
      nonInteractive: true,
      permissionMode: "bypassPermissions",
    })

    const decision = await manager.check({ tool: "shell", input: {}, cwd: "/" })

    expect(decision.action).toBe("allow")
    expect(decision.originalAction).toBe("deny")
    expect(decision.reason).toContain("bypassPermissions")
  })

  test("pattern rules include explain metadata", () => {
    const decision = evaluatePermission(
      { tool: "shell", input: { command: "curl https://example.test" }, cwd: "/", risk: "high" },
      [{ tool: "shell", pattern: "*curl*", action: "deny" }],
    )

    expect(decision.action).toBe("deny")
    expect(decision.rule).toMatchObject({ index: 0, tool: "shell", pattern: "*curl*", action: "deny" })
  })
})

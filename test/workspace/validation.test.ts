import { describe, expect, test } from "bun:test"
import { link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createSessionWorkspaceBinding } from "../../src/workspace/session"
import {
  listWorkspaceValidationRecords,
  readWorkspaceValidationRecords,
  resolveWorkspaceValidation,
  runWorkspaceValidation,
} from "../../src/workspace/validation"

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pixiu-validation-${name}-`))
  const projectRoot = join(root, "project")
  const stateRoot = join(root, "state")
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, "project.txt"), "source\n", "utf8")
  const binding = await createSessionWorkspaceBinding({
    stateRoot,
    projectRoot,
    sessionId: `session_${name}`,
  })
  return { root, projectRoot, binding }
}

describe("workspace validation", () => {
  test("resolves server presets and requires explicit custom commands", () => {
    expect(resolveWorkspaceValidation({ kind: "test" }, { test: "bun test" })).toEqual({
      kind: "test",
      command: "bun test",
    })
    expect(resolveWorkspaceValidation({ kind: "custom", command: "  make lint  " })).toEqual({
      kind: "custom",
      command: "make lint",
    })
    expect(() => resolveWorkspaceValidation({ kind: "build", command: "rm -rf ." }, { build: "bun run build" }))
      .toThrow("cannot be overridden")
    expect(() => resolveWorkspaceValidation({ kind: "custom" })).toThrow("must be a non-empty string")
    expect(() => resolveWorkspaceValidation({ kind: "typecheck" })).toThrow("No typecheck validation preset")
    expect(() => resolveWorkspaceValidation({ kind: "lint" })).toThrow("Unknown validation kind")
  })

  test("runs a preset in binding.workRoot and reads it by session, turn, and revision", async () => {
    const { projectRoot, binding } = await fixture("preset")
    const record = await runWorkspaceValidation(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_one",
      revision: "revision_one",
      kind: "test",
    }, {
      presets: { test: "pwd; test -f project.txt; printf validation-ok" },
      timeoutMs: 2_000,
      outputMaxBytes: 4_096,
      envAllowlist: ["PATH"],
      shell: "/bin/sh",
    })

    expect(record).toMatchObject({
      sessionId: binding.sessionId,
      turnId: "turn_one",
      revision: "revision_one",
      kind: "test",
      command: "pwd; test -f project.txt; printf validation-ok",
      status: "passed",
      exitCode: 0,
      truncated: false,
      timedOut: false,
    })
    expect(record.output).toContain(binding.workRoot)
    expect(record.output).toContain("validation-ok")
    expect(record.output).not.toContain(projectRoot)

    expect(await readWorkspaceValidationRecords(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_one",
      revision: "revision_one",
    })).toEqual([record])
    expect(await readWorkspaceValidationRecords(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_one",
      revision: "different_revision",
    })).toEqual([])
    expect(await listWorkspaceValidationRecords(binding)).toEqual([record])
  })

  test("records custom commands while redacting and bounding persisted output", async () => {
    const { binding } = await fixture("redaction")
    const secret = "sk-abcdefghijklmnop"
    const record = await runWorkspaceValidation(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_secret",
      revision: "revision_secret",
      kind: "custom",
      command: `API_KEY=supersecret; printf 'API_KEY=supersecret\\n${secret}\\n'; printf '界%.0s' $(seq 1 200)`,
    }, {
      timeoutMs: 2_000,
      outputMaxBytes: 96,
      envAllowlist: ["PATH"],
      shell: "/bin/sh",
    })

    expect(record.kind).toBe("custom")
    expect(record.status).toBe("passed")
    expect(record.command).toContain("API_KEY=[redacted]")
    expect(record.command).not.toContain("supersecret")
    expect(record.command).not.toContain(secret)
    expect(record.output).toContain("[redacted]")
    expect(record.output).not.toContain("supersecret")
    expect(record.output).not.toContain(secret)
    expect(record.truncated).toBe(true)
    expect(Buffer.byteLength(record.output)).toBeLessThanOrEqual(96)

    const content = await readFile(join(binding.root, "validations.jsonl"), "utf8")
    expect(content).not.toContain("supersecret")
    expect(content).not.toContain(secret)
  })

  test("honors very small output limits", async () => {
    const { binding } = await fixture("tiny-output")
    const record = await runWorkspaceValidation(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_tiny",
      revision: "revision_tiny",
      kind: "custom",
      command: "printf '界界界'",
    }, {
      timeoutMs: 2_000,
      outputMaxBytes: 8,
      envAllowlist: ["PATH"],
      shell: "/bin/sh",
    })

    expect(record.status).toBe("passed")
    expect(record.truncated).toBe(true)
    expect(Buffer.byteLength(record.output)).toBeLessThanOrEqual(8)
  })

  test("bounds output when validation is already cancelled", async () => {
    const { binding } = await fixture("pre-abort")
    const controller = new AbortController()
    controller.abort()
    const record = await runWorkspaceValidation(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_pre_abort",
      revision: "revision_pre_abort",
      kind: "custom",
      command: "true",
    }, {
      outputMaxBytes: 1,
      signal: controller.signal,
      shell: "/bin/sh",
    })

    expect(record).toMatchObject({ status: "cancelled", exitCode: 130, truncated: true })
    expect(Buffer.byteLength(record.output)).toBeLessThanOrEqual(1)
  })

  test("times out a long-running validation and persists the failure", async () => {
    const { binding } = await fixture("timeout")
    const record = await runWorkspaceValidation(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_timeout",
      revision: "revision_timeout",
      kind: "custom",
      command: "trap '' TERM; sleep 5",
    }, {
      timeoutMs: 50,
      outputMaxBytes: 1_024,
      envAllowlist: ["PATH"],
      shell: "/bin/sh",
    })

    expect(record).toMatchObject({ status: "failed", exitCode: 124, timedOut: true })
    expect(record.output).toContain("timed out")
    expect(record.durationMs).toBeLessThan(2_000)
    expect(await readWorkspaceValidationRecords(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_timeout",
      revision: "revision_timeout",
    })).toEqual([record])
  })

  test("cancels an active validation through AbortSignal", async () => {
    const { binding } = await fixture("abort")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 50)
    try {
      const record = await runWorkspaceValidation(binding, {
        sessionId: binding.sessionId,
        turnId: "turn_abort",
        revision: "revision_abort",
        kind: "custom",
        command: "sleep 5",
      }, {
        timeoutMs: 2_000,
        outputMaxBytes: 1_024,
        envAllowlist: ["PATH"],
        shell: "/bin/sh",
        signal: controller.signal,
      })

      expect(record).toMatchObject({ status: "cancelled", exitCode: 130, timedOut: false })
      expect(record.output).toContain("cancelled")
      expect(record.durationMs).toBeLessThan(2_000)
    } finally {
      clearTimeout(timer)
    }
  })

  test("rejects records addressed to a different session binding", async () => {
    const { binding } = await fixture("mismatch")
    await expect(runWorkspaceValidation(binding, {
      sessionId: "session_other",
      turnId: "turn_mismatch",
      revision: "revision_mismatch",
      kind: "custom",
      command: "true",
    }, { shell: "/bin/sh" })).rejects.toMatchObject({
      code: "WORKSPACE_VALIDATION_SESSION_MISMATCH",
    })
  })

  test("does not append through a hard-linked validation store", async () => {
    const { root, binding } = await fixture("hard-link")
    const outside = join(root, "outside.jsonl")
    await writeFile(outside, "outside\n", "utf8")
    await link(outside, join(binding.root, "validations.jsonl"))

    await expect(runWorkspaceValidation(binding, {
      sessionId: binding.sessionId,
      turnId: "turn_hard_link",
      revision: "revision_hard_link",
      kind: "custom",
      command: "true",
    }, { shell: "/bin/sh" })).rejects.toMatchObject({
      code: "WORKSPACE_VALIDATION_STORE_INVALID",
    })
    expect(await readFile(outside, "utf8")).toBe("outside\n")
  })
})

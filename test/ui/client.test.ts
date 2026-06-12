import { describe, expect, test } from "bun:test"

import { createUiApiClient } from "../../src/ui/client/api"
import { redactUiText } from "../../src/ui/client/redact"

describe("ui client", () => {
  test("sends the local token through the API client", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = []
    const client = createUiApiClient("local-token", async (path, init) => {
      calls.push({ path: String(path), init })
      return Response.json({ ok: true, data: { version: "0", cwd: "/tmp", provider: { model: "m", credential: "none", keyPresent: false }, workspace: {}, sessionsPath: "", skills: {}, mcp: {} } })
    })

    await client.status()

    expect(calls[0]?.path).toBe("/api/status")
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer local-token")
  })

  test("throws API errors with the server message", async () => {
    const client = createUiApiClient("local-token", async () => Response.json({ ok: false, code: "NOPE", message: "broken" }, { status: 500 }))

    await expect(client.status()).rejects.toThrow("broken")
  })

  test("redacts common secret shapes before rendering trace text", () => {
    const redacted = redactUiText("Authorization: Bearer sk-12345678901234567890\nAPI_KEY=abc123")

    expect(redacted).not.toContain("sk-12345678901234567890")
    expect(redacted).not.toContain("abc123")
    expect(redacted).toContain("[redacted]")
  })
})

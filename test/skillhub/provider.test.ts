import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { SkillHubProvider, installRemoteSkill } from "../../src/skillhub/provider"
import { SkillLoader } from "../../src/skills/loader"

describe("SkillHub provider", () => {
  test("searches and installs from a fake SkillHub server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/api/v1/skills/search")) {
          return Response.json({ skills: [{ id: "demo", name: "demo", description: "Demo", source: "fake", version: "1.0.0" }] })
        }
        if (url.pathname.endsWith("/api/v1/skills/demo")) {
          return Response.json({
            id: "demo",
            name: "demo",
            description: "Demo",
            source: "fake",
            version: "1.0.0",
            updatedAt: "2026-06-05T00:00:00.000Z",
            files: [
              { path: "SKILL.md", content: "---\nname: demo\ndescription: Demo\n---\nbody" },
              { path: "references/guide.md", content: "guide" },
            ],
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    try {
      const provider = new SkillHubProvider({ baseURL: `http://127.0.0.1:${server.port}` })
      const skills = await provider.search("demo")
      expect(skills[0]?.name).toBe("demo")
      const root = await mkdtemp(join(tmpdir(), "minicode-skillhub-"))
      const result = await installRemoteSkill(await provider.detail("demo"), root, { installedAt: "2026-06-05T01:02:03.000Z" })
      expect(result.manifestPath).toBe(join(root, "demo", ".source.json"))
      expect(result.files.map((file) => file.path)).toEqual(["SKILL.md", "references/guide.md", ".source.json"])
      expect(result.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)

      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"))
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        installer: "minicode",
        installedAt: "2026-06-05T01:02:03.000Z",
        remote: { id: "demo", name: "demo", source: "fake", version: "1.0.0" },
        targetDir: join(root, "demo"),
      })
      expect(manifest.files[1]).toMatchObject({ path: "references/guide.md", bytes: "guide".length })
      expect((await new SkillLoader([root]).load("demo")).files.map((file) => file.path)).toEqual([".source.json", "references/guide.md"])
    } finally {
      server.stop(true)
    }
  })

  test("rejects remote skill file path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skillhub-paths-"))
    await expect(
      installRemoteSkill(
        {
          id: "bad",
          name: "bad",
          description: "Bad",
          source: "fake",
          files: [{ path: "../evil.txt", content: "evil" }],
        },
        root,
      ),
    ).rejects.toThrow("Invalid remote skill file path")
  })
})

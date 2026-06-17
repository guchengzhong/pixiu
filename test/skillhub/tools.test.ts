import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createSkillHubTools } from "../../src/skillhub/tools"

describe("SkillHub tools", () => {
  test("skillhub_install reports manifest metadata", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/api/v1/skills/demo")) {
          return Response.json({
            id: "demo",
            name: "demo",
            description: "Demo",
            source: "fake",
            content: "---\nname: demo\ndescription: Demo\n---\nbody",
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    try {
      const cwd = await mkdtemp(join(tmpdir(), "pixiu-skillhub-tool-"))
      const install = createSkillHubTools({ baseURL: `http://127.0.0.1:${server.port}`, installDir: "skills" }, cwd).find(
        (tool) => tool.name === "skillhub_install",
      )!
      const result = await install.execute({ id: "demo" }, {} as any)

      expect(result.ok).toBe(true)
      expect(result.content).toContain("Manifest:")
      expect(result.metadata?.manifestPath).toBe(join(cwd, "skills", "demo", ".source.json"))
      expect(result.metadata?.activity).toMatchObject({ kind: "artifact", title: "Installed skill", target: join(cwd, "skills", "demo") })
      const manifest = JSON.parse(await readFile(join(cwd, "skills", "demo", ".source.json"), "utf8"))
      expect(manifest.remote.id).toBe("demo")
    } finally {
      server.stop(true)
    }
  })
})

import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { expectExit, withMinicodeFixture } from "../harness/minicode-process"

describe("skill CLI", () => {
  test("lists, searches, and shows local skills", async () => {
    await withMinicodeFixture(async ({ projectDir, exec }) => {
      await mkdir(join(projectDir, ".minicode", "skills", "demo"), { recursive: true })
      await writeFile(
        join(projectDir, ".minicode", "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: TypeScript demo skill\n---\nUse TypeScript patterns.",
        "utf8",
      )

      const list = await exec(["skill", "list"])
      expectExit(list, 0, "skill list")
      expect(list.stdout).toContain("skill")
      expect(list.stdout).toContain("description")
      expect(list.stdout).toContain("source")
      expect(list.stdout).toContain("demo")
      expect(list.stdout).toContain("TypeScript demo skill")
      expect(list.stdout).toContain("demo/SKILL.md")

      const search = await exec(["skill", "search", "typescript"])
      expectExit(search, 0, "skill search")
      expect(search.stdout).toContain("demo")
      expect(search.stdout).toContain("TypeScript demo skill")
      expect(search.stdout).toContain("demo/SKILL.md")

      const show = await exec(["skill", "show", "demo"])
      expectExit(show, 0, "skill show")
      expect(show.stdout).toContain("Use TypeScript patterns.")
    })
  })

  test("list --json includes diagnostics", async () => {
    await withMinicodeFixture(async ({ projectDir, exec }) => {
      await mkdir(join(projectDir, ".minicode", "skills", "bad"), { recursive: true })
      await writeFile(join(projectDir, ".minicode", "skills", "bad", "SKILL.md"), "---\nname: bad\n---\n", "utf8")

      const result = await exec(["skill", "list", "--json"])
      expectExit(result, 0, "skill list --json")
      const parsed = JSON.parse(result.stdout)
      expect(parsed.skills).toEqual([])
      expect(parsed.diagnostics[0].code).toBe("SKILL_INVALID")
    })
  })

  test("remote install prints a plan before --yes and writes provenance after confirmation", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/api/v1/skills/demo")) {
          return Response.json({
            id: "demo",
            name: "demo",
            description: "Remote demo",
            source: "fake",
            content: "---\nname: demo\ndescription: Remote demo\n---\nremote body",
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    try {
      await withMinicodeFixture(async ({ projectDir, exec }) => {
        const configPath = join(projectDir, "minicode.jsonc")
        const config = JSON.parse(await readFile(configPath, "utf8"))
        config.skillhub.baseURL = `http://127.0.0.1:${server.port}`
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

        const plan = await exec(["skill", "install", "demo"])
        expectExit(plan, 1, "skill install plan")
        expect(plan.stdout).toContain("Install plan:")
        expect(plan.stdout).toContain("Re-run with --yes")
        expect(plan.stdout).toContain("SKILL.md")

        const installed = await exec(["skill", "install", "demo", "--yes"])
        expectExit(installed, 0, "skill install --yes")
        expect(installed.stdout).toContain("installed demo")
        expect(installed.stdout).toContain("manifest:")
        expect(installed.stdout).toContain(".source.json")

        const manifest = JSON.parse(await readFile(join(projectDir, ".minicode", "skills", "demo", ".source.json"), "utf8"))
        expect(manifest.remote).toMatchObject({ id: "demo", name: "demo", source: "fake" })
        expect(manifest.files[0].path).toBe("SKILL.md")
        expect(manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/)
      })
    } finally {
      server.stop(true)
    }
  })

  test("initializes a local skill from the CLI", async () => {
    await withMinicodeFixture(async ({ projectDir, exec }) => {
      const result = await exec(["skill", "init", "demo-skill", "--description", "Demo CLI skill"])
      expectExit(result, 0, "skill init")
      expect(result.stdout).toContain("created skill demo-skill")

      const content = await readFile(join(projectDir, ".minicode", "skills", "demo-skill", "SKILL.md"), "utf8")
      expect(content).toContain("name: demo-skill")
      expect(content).toContain("description: Demo CLI skill")

      const list = await exec(["skill", "list"])
      expectExit(list, 0, "skill list after init")
      expect(list.stdout).toContain("demo-skill")
      expect(list.stdout).toContain("Demo CLI skill")
      expect(list.stdout).toContain("demo-skill/SKILL.md")
    })
  })

  test("manages skill paths from the CLI", async () => {
    await withMinicodeFixture(async ({ projectDir, exec }) => {
      const add = await exec(["skill", "path", "add", "custom-skills", "--json"])
      expectExit(add, 0, "skill path add")
      expect(JSON.parse(add.stdout)).toMatchObject({ path: "custom-skills", changed: true })

      const list = await exec(["skill", "path", "list"])
      expectExit(list, 0, "skill path list")
      expect(list.stdout).toContain(".minicode/skills")
      expect(list.stdout).toContain("custom-skills")

      const config = JSON.parse(await readFile(join(projectDir, "minicode.jsonc"), "utf8"))
      expect(config.skills.paths).toContain("custom-skills")

      const remove = await exec(["skill", "path", "remove", "custom-skills", "--json"])
      expectExit(remove, 0, "skill path remove")
      expect(JSON.parse(remove.stdout)).toMatchObject({ path: "custom-skills", changed: true })

      const after = JSON.parse(await readFile(join(projectDir, "minicode.jsonc"), "utf8"))
      expect(after.skills.paths).not.toContain("custom-skills")
    })
  })

  test("doctor reports skill diagnostics", async () => {
    await withMinicodeFixture(async ({ projectDir, exec }) => {
      await mkdir(join(projectDir, ".minicode", "skills", "bad"), { recursive: true })
      await writeFile(join(projectDir, ".minicode", "skills", "bad", "SKILL.md"), "---\nname: bad\n---\n", "utf8")

      const result = await exec(["skill", "doctor", "--json"])
      expectExit(result, 1, "skill doctor")
      const parsed = JSON.parse(result.stdout)
      expect(parsed.diagnostics[0].code).toBe("SKILL_INVALID")
    })
  })
})

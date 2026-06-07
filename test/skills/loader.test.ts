import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { SkillLoader } from "../../src/skills/loader"

describe("skill loader", () => {
  test("discovers and loads local skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skills-"))
    await mkdir(join(root, "demo", "references"), { recursive: true })
    await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nbody", "utf8")
    await writeFile(join(root, "demo", "references", "usage.md"), "reference body", "utf8")
    const loader = new SkillLoader([root])

    const summary = (await loader.list())[0]!
    expect(summary.name).toBe("demo")
    expect(summary.source).toEqual({ root, rootIndex: 0, relativePath: "demo/SKILL.md" })

    const loaded = await loader.load("demo")
    expect(loaded.content).toContain("body")
    expect(loaded.files).toEqual([{ path: "references/usage.md", size: "reference body".length }])
    expect(await loader.readRelative("demo", "references/usage.md")).toBe("reference body")
  })

  test("falls back to heading and body when frontmatter is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skills-heading-"))
    await mkdir(join(root, "heading"), { recursive: true })
    await writeFile(join(root, "heading", "SKILL.md"), "# heading-skill\n\nUse this skill for heading fallback.", "utf8")
    const loader = new SkillLoader([root])

    expect((await loader.list())[0]?.name).toBe("heading-skill")
    expect((await loader.list())[0]?.description).toBe("Use this skill for heading fallback.")
  })

  test("parses simple multiline frontmatter descriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skills-frontmatter-"))
    await mkdir(join(root, "multi"), { recursive: true })
    await writeFile(join(root, "multi", "SKILL.md"), "---\nname: multi\ndescription: |\n  Line one.\n  Line two.\n---\nbody", "utf8")
    const loader = new SkillLoader([root])

    expect((await loader.list())[0]?.description).toBe("Line one.\nLine two.")
  })

  test("searches local skills by name, description, and path", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skills-search-"))
    await mkdir(join(root, "react"), { recursive: true })
    await mkdir(join(root, "python"), { recursive: true })
    await writeFile(join(root, "react", "SKILL.md"), "---\nname: react-ui\ndescription: Build React components\n---\nbody", "utf8")
    await writeFile(join(root, "python", "SKILL.md"), "---\nname: scripts\ndescription: Python automation\n---\nbody", "utf8")
    const loader = new SkillLoader([root])

    expect((await loader.search("react")).map((skill) => skill.name)).toEqual(["react-ui"])
    expect((await loader.search("automation")).map((skill) => skill.name)).toEqual(["scripts"])
    expect((await loader.search("python/SKILL")).map((skill) => skill.name)).toEqual(["scripts"])
  })

  test("keeps deterministic first source and reports duplicate skills", async () => {
    const first = await mkdtemp(join(tmpdir(), "minicode-skills-first-"))
    const second = await mkdtemp(join(tmpdir(), "minicode-skills-second-"))
    await mkdir(join(first, "demo"), { recursive: true })
    await mkdir(join(second, "demo"), { recursive: true })
    await writeFile(join(first, "demo", "SKILL.md"), "---\nname: demo\ndescription: First source\n---\nfirst", "utf8")
    await writeFile(join(second, "demo", "SKILL.md"), "---\nname: demo\ndescription: Second source\n---\nsecond", "utf8")
    const loader = new SkillLoader([first, second])

    const [skill] = await loader.list()
    expect(skill?.description).toBe("First source")
    expect(skill?.duplicates?.[0]?.source.root).toBe(second)
    const duplicate = (await loader.diagnostics()).find((item) => item.code === "SKILL_DUPLICATE")
    expect(duplicate?.message).toContain("Duplicate skill")
  })

  test("skips invalid skills and exposes diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skills-invalid-"))
    await mkdir(join(root, "bad"), { recursive: true })
    await writeFile(join(root, "bad", "SKILL.md"), "---\nname: bad\n---\n", "utf8")
    const loader = new SkillLoader([root])

    expect(await loader.list()).toEqual([])
    const diagnostics = await loader.diagnostics()
    expect(diagnostics[0]?.code).toBe("SKILL_INVALID")
    expect(diagnostics[0]?.skillPath).toContain("SKILL.md")
  })

  test("rejects relative path escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skills-escape-"))
    await mkdir(join(root, "demo"), { recursive: true })
    await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nbody", "utf8")
    const loader = new SkillLoader([root])

    await expect(loader.readRelative("demo", "../outside.txt")).rejects.toThrow("escapes root")
  })

  test("rejects empty and absolute reference paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skills-paths-"))
    await mkdir(join(root, "demo"), { recursive: true })
    await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nbody", "utf8")
    const loader = new SkillLoader([root])

    await expect(loader.readRelative("demo", " ")).rejects.toThrow("relative file path")
    await expect(loader.readRelative("demo", "/tmp/outside.txt")).rejects.toThrow("relative file path")
  })
})

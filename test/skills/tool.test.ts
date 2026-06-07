import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { SkillLoader } from "../../src/skills/loader"
import { createSkillTools } from "../../src/skills/tool"

describe("skill tool", () => {
  test("loads main skill instructions with reference file context", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skill-tool-"))
    await mkdir(join(root, "demo", "references"), { recursive: true })
    await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nUse demo carefully.", "utf8")
    await writeFile(join(root, "demo", "references", "guide.md"), "Guide body", "utf8")

    const tool = createSkillTools(new SkillLoader([root]))[0]!
    const result = await tool.execute({ name: "demo" }, {} as any)

    expect(result.ok).toBe(true)
    expect(result.content).toContain("Skill: demo")
    expect(result.content).toContain("references/guide.md")
    expect(result.content).toContain("Use demo carefully.")
    expect(result.metadata?.kind).toBe("main")
  })

  test("loads a skill-relative reference file", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-skill-tool-ref-"))
    await mkdir(join(root, "demo", "references"), { recursive: true })
    await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nbody", "utf8")
    await writeFile(join(root, "demo", "references", "guide.md"), "Guide body", "utf8")

    const tool = createSkillTools(new SkillLoader([root]))[0]!
    const result = await tool.execute({ name: "demo", path: "references/guide.md" }, {} as any)

    expect(result.ok).toBe(true)
    expect(result.content).toBe("Guide body")
    expect(result.metadata?.kind).toBe("reference")
    expect(result.metadata?.path).toBe("references/guide.md")
  })
})

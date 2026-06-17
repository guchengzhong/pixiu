import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { SkillLoader } from "../../src/skills/loader"
import { createSkillTools, renderSkillSystemPrompt } from "../../src/skills/tool"

describe("skill tool", () => {
  test("loads main skill instructions with reference file context", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-skill-tool-"))
    await mkdir(join(root, "demo", "references"), { recursive: true })
    await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nUse demo carefully.", "utf8")
    await writeFile(join(root, "demo", "references", "guide.md"), "Guide body", "utf8")

    const tool = createSkillTools(new SkillLoader([root])).find((item) => item.name === "skill")!
    const result = await tool.execute({ name: "demo" }, {} as any)

    expect(result.ok).toBe(true)
    expect(result.content).toContain("Skill: demo")
    expect(result.content).toContain("references/guide.md")
    expect(result.content).toContain("Use demo carefully.")
    expect(result.metadata?.kind).toBe("main")
    expect(result.metadata?.activity).toMatchObject({ kind: "skill", title: "Loaded skill", target: "demo" })
  })

  test("searches installed skills before loading one", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-skill-tool-search-"))
    await mkdir(join(root, "demo"), { recursive: true })
    await mkdir(join(root, "other"), { recursive: true })
    await writeFile(
      join(root, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\ntriggers: workflow, example\nrisk: low\n---\nbody",
      "utf8",
    )
    await writeFile(join(root, "other", "SKILL.md"), "---\nname: other\ndescription: Other skill\n---\nbody", "utf8")

    const tool = createSkillTools(new SkillLoader([root])).find((item) => item.name === "skill_search")!
    const result = await tool.execute({ query: "workflow" }, {} as any)

    expect(result.ok).toBe(true)
    expect(result.content).toContain("demo")
    expect(result.content).toContain("triggers=workflow, example")
    expect(result.metadata?.kind).toBe("search")
    expect(result.metadata?.skills).toEqual(["demo"])
    expect(result.metadata?.activity).toMatchObject({ kind: "skill", title: "Searched skills", target: "workflow" })
  })

  test("loads a skill-relative reference file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-skill-tool-ref-"))
    await mkdir(join(root, "demo", "references"), { recursive: true })
    await writeFile(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nbody", "utf8")
    await writeFile(join(root, "demo", "references", "guide.md"), "Guide body", "utf8")

    const tool = createSkillTools(new SkillLoader([root])).find((item) => item.name === "skill")!
    const result = await tool.execute({ name: "demo", path: "references/guide.md" }, {} as any)

    expect(result.ok).toBe(true)
    expect(result.content).toBe("Guide body")
    expect(result.metadata?.kind).toBe("reference")
    expect(result.metadata?.path).toBe("references/guide.md")
    expect(result.metadata?.activity).toMatchObject({ kind: "skill", title: "Loaded skill reference", target: "demo/references/guide.md" })
  })

  test("uses compact skill_search guidance when many skills are installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pixiu-skill-tool-many-"))
    for (let index = 0; index < 21; index += 1) {
      await mkdir(join(root, `skill-${index}`), { recursive: true })
      await writeFile(
        join(root, `skill-${index}`, "SKILL.md"),
        `---\nname: skill-${index}\ndescription: Skill ${index}\n---\nbody`,
        "utf8",
      )
    }

    const prompt = await renderSkillSystemPrompt(new SkillLoader([root]))
    expect(prompt).toContain("21 installed local skills")
    expect(prompt).toContain("skill_search")
    expect(prompt).not.toContain("- skill-0:")
  })
})

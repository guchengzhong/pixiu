#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { AGENT_REACH_SKILL_FILES, AGENT_REACH_TEMPLATE_VERSION } from "../src/skills/agent-reach-template"

type Options = {
  check: boolean
  targetDir: string
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const mismatches: string[] = []
  for (const file of AGENT_REACH_SKILL_FILES) {
    const targetPath = join(options.targetDir, file.path)
    const expected = withFinalNewline(file.content)
    if (options.check) {
      const actual = await readFile(targetPath, "utf8").catch((error: any) => {
        if (error?.code === "ENOENT") return undefined
        throw error
      })
      if (actual !== expected) mismatches.push(file.path)
      continue
    }
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, expected, "utf8")
  }

  if (options.check) {
    if (mismatches.length) {
      console.error(`Agent Reach adapter skill is out of sync with template ${AGENT_REACH_TEMPLATE_VERSION}:`)
      for (const path of mismatches) console.error(`- ${path}`)
      console.error("Run: bun run scripts/sync-agent-reach-skill.ts")
      process.exit(1)
    }
    console.log(`Agent Reach adapter skill is in sync with template ${AGENT_REACH_TEMPLATE_VERSION}.`)
    return
  }

  console.log(`Synced Agent Reach adapter skill ${AGENT_REACH_TEMPLATE_VERSION} to ${options.targetDir}`)
}

function parseArgs(args: string[]): Options {
  const check = args.includes("--check")
  const targetFlag = takeFlagValue(args, "--target")
  return {
    check,
    targetDir: resolve(process.cwd(), targetFlag ?? ".pixiu/skills/agent-reach"),
  }
}

function takeFlagValue(args: string[], flag: string) {
  const equals = args.find((item) => item.startsWith(`${flag}=`))
  if (equals) return equals.slice(flag.length + 1)
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function withFinalNewline(value: string) {
  return value.endsWith("\n") ? value : `${value}\n`
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { BROWSER_USE_SKILL_FILES, BROWSER_USE_TEMPLATE_VERSION } from "../src/skills/browser-use-template"

type Options = {
  check: boolean
  targetDir: string
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const mismatches: string[] = []
  for (const file of BROWSER_USE_SKILL_FILES) {
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
      console.error(`Browser Use adapter skill is out of sync with template ${BROWSER_USE_TEMPLATE_VERSION}:`)
      for (const path of mismatches) console.error(`- ${path}`)
      console.error("Run: bun run scripts/sync-browser-use-skill.ts")
      process.exit(1)
    }
    console.log(`Browser Use adapter skill is in sync with template ${BROWSER_USE_TEMPLATE_VERSION}.`)
    return
  }

  console.log(`Synced Browser Use adapter skill ${BROWSER_USE_TEMPLATE_VERSION} to ${options.targetDir}`)
}

function parseArgs(args: string[]): Options {
  const check = args.includes("--check")
  const targetFlag = takeFlagValue(args, "--target")
  return {
    check,
    targetDir: resolve(process.cwd(), targetFlag ?? ".pixiu/skills/browser-use"),
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

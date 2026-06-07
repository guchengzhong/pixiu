import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative } from "node:path"

import { findOutsideWorkspaceShellWrite, runShell } from "../sandbox/shell"
import { truncateText } from "../shared/text"
import type { JsonObject } from "../shared/json"
import { numberField, stringField } from "./schema"
import type { ToolContext, ToolDefinition } from "./types"

async function walkFiles(root: string, includeHidden = false): Promise<string[]> {
  const entries: string[] = []
  for await (const entry of new Bun.Glob(includeHidden ? "**/*" : "**/[!.]*").scan({ cwd: root, onlyFiles: true })) {
    entries.push(entry)
  }
  return entries.sort()
}

function summarizeDiff(path: string, before: string, after: string) {
  if (before === after) return `No changes for ${path}`
  return [`Changed ${path}`, `before: ${before.length} chars`, `after: ${after.length} chars`].join("\n")
}

async function resolveToolPath(tool: string, path: string, context: ToolContext) {
  try {
    return context.pathGuard.resolvePath(path)
  } catch (error: any) {
    if (error?.code !== "PATH_OUTSIDE_WORKSPACE") throw error
    const decision = await context.permissions.check({
      tool: `${tool}:outside_workspace`,
      input: { path, outsideWorkspace: true },
      cwd: context.cwd,
      risk: "high",
      reason: "path outside workspace",
    })
    if (decision.action === "allow") return context.pathGuard.resolvePath(path, { allowOutside: true })
    throw new Error(`Permission denied for outside-workspace path ${path}: ${decision.reason}`)
  }
}

export function createBuiltinTools(): ToolDefinition[] {
  return [
    {
      name: "read",
      description: "Read a text file from the workspace.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to read." },
          maxBytes: { type: "number", description: "Maximum bytes to return." },
        },
        required: ["path"],
      },
      async execute(input, context) {
        const guarded = await resolveToolPath("read", stringField(input, "path"), context)
        const maxBytes = numberField(input, "maxBytes", context.config.outputMaxBytes)
        const content = await readFile(guarded.absolutePath, "utf8")
        const truncated = truncateText(content, maxBytes)
        return {
          ok: true,
          content: truncated.text,
          metadata: { path: guarded.relativePath, bytes: truncated.bytes, truncated: truncated.truncated },
        }
      },
    },
    {
      name: "glob",
      description: "List files matching a glob pattern inside the workspace.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["pattern"],
      },
      async execute(input, context) {
        const cwd = (await resolveToolPath("glob", stringField(input, "cwd", "."), context)).absolutePath
        const pattern = stringField(input, "pattern")
        const files: string[] = []
        for await (const file of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
          files.push(relative(context.workspaceRoot, `${cwd}/${file}`))
        }
        return { ok: true, content: files.join("\n"), data: files }
      },
    },
    {
      name: "grep",
      description: "Search text files in the workspace for a string or regular expression.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          regex: { type: "boolean" },
          maxResults: { type: "number" },
        },
        required: ["query"],
      },
      async execute(input, context) {
        const root = (await resolveToolPath("grep", stringField(input, "path", "."), context)).absolutePath
        const query = stringField(input, "query")
        const regex = input.regex === true ? new RegExp(query, "i") : undefined
        const maxResults = numberField(input, "maxResults", 100)
        const results: string[] = []
        for (const file of await walkFiles(root)) {
          if (results.length >= maxResults) break
          const absolute = `${root}/${file}`
          let content = ""
          try {
            content = await readFile(absolute, "utf8")
          } catch {
            continue
          }
          const lines = content.split(/\r?\n/)
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]!
            const matched = regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase())
            if (!matched) continue
            results.push(`${relative(context.workspaceRoot, absolute)}:${index + 1}:${line}`)
            if (results.length >= maxResults) break
          }
        }
        return { ok: true, content: results.join("\n") || "No matches", data: results }
      },
    },
    {
      name: "shell",
      description: "Run a shell command or temporary script in the workspace with timeout and output truncation.",
      risk: "high",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["command"],
      },
      async execute(input, context) {
        const cwd = (await resolveToolPath("shell", stringField(input, "cwd", "."), context)).absolutePath
        const command = stringField(input, "command")
        const outsideTarget = findOutsideWorkspaceShellWrite(command, context.workspaceRoot)
        if (outsideTarget) {
          return {
            ok: false,
            content: `Shell command appears to write outside the workspace: ${outsideTarget}`,
            metadata: {
              command,
              cwd,
              workspaceRoot: context.workspaceRoot,
              outsideWorkspaceTarget: outsideTarget,
            },
          }
        }
        const shellOptions = {
          cwd,
          timeoutMs: numberField(input, "timeoutMs", context.config.shellTimeoutMs),
          outputMaxBytes: context.config.outputMaxBytes,
          envAllowlist: context.config.envAllowlist,
        }
        const result = await runShell(
          command,
          context.signal ? { ...shellOptions, signal: context.signal } : shellOptions,
        )
        return {
          ok: result.exitCode === 0 && !result.timedOut,
          content: [`exitCode: ${result.exitCode}`, result.timedOut ? "timedOut: true" : "", result.stdout, result.stderr]
            .filter(Boolean)
            .join("\n"),
          metadata: {
            command,
            cwd,
            exitCode: result.exitCode ?? -1,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
          },
        }
      },
    },
    {
      name: "write",
      description: "Write a text file inside the workspace.",
      risk: "high",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      async execute(input, context) {
        const guarded = await resolveToolPath("write", stringField(input, "path"), context)
        let before = ""
        try {
          before = await readFile(guarded.absolutePath, "utf8")
        } catch {
          before = ""
        }
        await mkdir(dirname(guarded.absolutePath), { recursive: true })
        await writeFile(guarded.absolutePath, stringField(input, "content"), "utf8")
        return {
          ok: true,
          content: summarizeDiff(guarded.relativePath, before, stringField(input, "content")),
          metadata: { path: guarded.relativePath },
        }
      },
    },
    {
      name: "edit",
      description: "Replace exact text in a workspace file.",
      risk: "high",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
      },
      async execute(input, context) {
        const guarded = await resolveToolPath("edit", stringField(input, "path"), context)
        const before = await readFile(guarded.absolutePath, "utf8")
        const oldText = stringField(input, "oldText")
        if (!before.includes(oldText)) return { ok: false, content: `oldText not found in ${guarded.relativePath}` }
        const after = before.replace(oldText, stringField(input, "newText"))
        await writeFile(guarded.absolutePath, after, "utf8")
        return { ok: true, content: summarizeDiff(guarded.relativePath, before, after), metadata: { path: guarded.relativePath } }
      },
    },
    {
      name: "patch",
      description: "Apply a simple file replacement patch: {path, content}.",
      risk: "high",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      async execute(input, context) {
        const writeTool = createBuiltinTools().find((tool) => tool.name === "write")!
        return writeTool.execute(input as JsonObject, context)
      },
    },
    {
      name: "todo",
      description: "Return a compact todo note or echo provided todo items.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" } },
        },
      },
      async execute(input) {
        const items = Array.isArray(input.items) ? input.items.map(String) : []
        return {
          ok: true,
          content: items.length ? items.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No todo items provided.",
          data: items,
        }
      },
    },
  ]
}

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative } from "node:path"

import { findOutsideWorkspaceShellWrite, runShell } from "../sandbox/shell"
import { truncateText } from "../shared/text"
import type { JsonObject } from "../shared/json"
import type { TodoItem, TodoPriority, TodoStatus } from "../todo/types"
import { numberField, stringField } from "./schema"
import type { ToolContext, ToolDefinition } from "./types"

const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"])
const TODO_PRIORITIES = new Set<TodoPriority>(["high", "medium", "low"])

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

function normalizeTodos(value: unknown) {
  if (!Array.isArray(value)) throw new Error("todowrite.todos must be an array.")
  const seenMissingIds = new Map<string, number>()
  const todos = value.map((item, index) => normalizeTodoItem(item, index, seenMissingIds))
  const inProgress = todos.filter((item) => item.status === "in_progress")
  if (inProgress.length > 1) throw new Error("todowrite accepts at most one in_progress todo.")
  return todos
}

function normalizeTodoItem(value: unknown, index: number, seenMissingIds: Map<string, number>): TodoItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`todowrite.todos[${index}] must be an object.`)
  }
  const item = value as Record<string, unknown>
  const content = typeof item.content === "string" ? item.content.trim().replace(/\s+/g, " ") : ""
  if (!content) throw new Error(`todowrite.todos[${index}].content must be a non-empty string.`)
  const status = typeof item.status === "string" && TODO_STATUSES.has(item.status as TodoStatus) ? (item.status as TodoStatus) : undefined
  if (!status) throw new Error(`todowrite.todos[${index}].status must be pending, in_progress, completed, or cancelled.`)
  const priority = typeof item.priority === "string" && TODO_PRIORITIES.has(item.priority as TodoPriority) ? (item.priority as TodoPriority) : undefined
  if (!priority) throw new Error(`todowrite.todos[${index}].priority must be high, medium, or low.`)
  const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : stableTodoId(content, seenMissingIds)
  return { id, content, status, priority }
}

function stableTodoId(content: string, seenMissingIds: Map<string, number>) {
  const base = `todo_${slugify(content).slice(0, 48) || "item"}`
  const next = (seenMissingIds.get(base) ?? 0) + 1
  seenMissingIds.set(base, next)
  return next === 1 ? base : `${base}_${next}`
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function renderTodos(todos: TodoItem[]) {
  if (!todos.length) return "No todo items provided."
  return todos.map((todo) => `- [${statusMarker(todo.status)}] (${todo.priority}) ${todo.content} #${todo.id}`).join("\n")
}

function statusMarker(status: TodoStatus) {
  if (status === "completed") return "x"
  if (status === "in_progress") return ">"
  if (status === "cancelled") return "-"
  return " "
}

function legacyTodoItems(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item).trim().replace(/\s+/g, " "))
        .filter(Boolean)
    : []
}

function legacyTodos(items: string[]) {
  const seenMissingIds = new Map<string, number>()
  return items.map((content) => ({
    id: stableTodoId(content, seenMissingIds),
    content,
    status: "pending" as const,
    priority: "medium" as const,
  }))
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
          metadata: {
            path: guarded.relativePath,
            bytes: truncated.bytes,
            truncated: truncated.truncated,
            activity: {
              kind: "file",
              title: "Read file",
              summary: `Read ${guarded.relativePath}`,
              target: guarded.relativePath,
            },
          },
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
        return {
          ok: true,
          content: files.join("\n"),
          data: files,
          metadata: {
            pattern,
            cwd: relative(context.workspaceRoot, cwd) || ".",
            resultCount: files.length,
            activity: {
              kind: "search",
              title: "Listed files",
              summary: `Listed ${pattern}`,
              target: pattern,
              details: { resultCount: files.length },
            },
          },
        }
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
        return {
          ok: true,
          content: results.join("\n") || "No matches",
          data: results,
          metadata: {
            query,
            resultCount: results.length,
            activity: {
              kind: "search",
              title: "Searched files",
              summary: `Searched for ${query}`,
              target: query,
              details: { resultCount: results.length },
            },
          },
        }
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
              activity: {
                kind: "shell",
                title: "Command failed",
                summary: `Failed ${command}`,
                command,
                status: "error",
                details: { outsideWorkspaceTarget: outsideTarget },
              },
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
            activity: {
              kind: "shell",
              title: result.exitCode === 0 && !result.timedOut ? "Ran command" : "Command failed",
              summary: result.exitCode === 0 && !result.timedOut ? `Ran ${command}` : `Failed ${command}`,
              command,
              status: result.exitCode === 0 && !result.timedOut ? "success" : "error",
              details: {
                exitCode: result.exitCode ?? -1,
                timedOut: result.timedOut,
                durationMs: result.durationMs,
              },
            },
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
          metadata: {
            path: guarded.relativePath,
            activity: {
              kind: "file",
              title: "Updated file",
              summary: `Updated ${guarded.relativePath}`,
              target: guarded.relativePath,
            },
          },
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
        if (!before.includes(oldText)) {
          return {
            ok: false,
            content: `oldText not found in ${guarded.relativePath}`,
            metadata: {
              path: guarded.relativePath,
              activity: {
                kind: "file",
                title: "File edit failed",
                summary: `Could not edit ${guarded.relativePath}`,
                target: guarded.relativePath,
                status: "error",
              },
            },
          }
        }
        const after = before.replace(oldText, stringField(input, "newText"))
        await writeFile(guarded.absolutePath, after, "utf8")
        return {
          ok: true,
          content: summarizeDiff(guarded.relativePath, before, after),
          metadata: {
            path: guarded.relativePath,
            activity: {
              kind: "file",
              title: "Edited file",
              summary: `Edited ${guarded.relativePath}`,
              target: guarded.relativePath,
            },
          },
        }
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
      description: "Legacy compatibility todo note. Prefer todowrite for structured task progress.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" } },
        },
      },
      async execute(input) {
        const items = legacyTodoItems(input.items)
        const todos = legacyTodos(items)
        return {
          ok: true,
          content: items.length ? items.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No todo items provided.",
          data: items,
          metadata: {
            todos,
            activity: {
              kind: "system",
              title: "Updated todos",
              summary: `Updated ${todos.length} todo${todos.length === 1 ? "" : "s"}`,
              details: { count: todos.length },
            },
          },
        }
      },
    },
    {
      name: "todowrite",
      description: "Write the complete structured todo-list snapshot for non-trivial task progress. Use for multi-step work, file changes, checklists, or verification runs; avoid for simple Q&A. Todos are execution progress, not hidden reasoning.",
      risk: "low",
      inputSchema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Complete todo-list snapshot. This replaces the previous todo state; it is not an incremental patch. Preserve ids, keep at most one in_progress item, and mark completed only after needed verification.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable todo id. Preserve existing ids when updating a todo." },
                content: { type: "string", description: "User-visible todo content." },
                status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
                priority: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["content", "status", "priority"],
            },
          },
        },
        required: ["todos"],
      },
      async execute(input) {
        const todos = normalizeTodos(input.todos)
        return {
          ok: true,
          content: renderTodos(todos),
          metadata: {
            todos,
            activity: {
              kind: "system",
              title: "Updated todos",
              summary: `Updated ${todos.length} todo${todos.length === 1 ? "" : "s"}`,
              details: { count: todos.length },
            },
          },
        }
      },
    },
  ]
}

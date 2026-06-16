import { mkdir, readdir, readFile, writeFile, appendFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { createID } from "../shared/id"
import { PixiuError } from "../shared/errors"
import type { TodoItem } from "../todo/types"
import type { CreateSessionInput, SessionMessage, SessionRecord, SessionStore, SessionTodoState } from "./types"

type SessionLine =
  | { type: "session"; session: SessionRecord }
  | { type: "message"; message: SessionMessage }
  | { type: "update"; patch: Partial<SessionRecord> }
  | { type: "todo_state"; state: SessionTodoState }

export class JsonlSessionStore implements SessionStore {
  constructor(private readonly rootDir: string) {}

  private path(sessionId: string) {
    return join(this.rootDir, `${sessionId}.jsonl`)
  }

  private async appendLine(sessionId: string, line: SessionLine) {
    await mkdir(dirname(this.path(sessionId)), { recursive: true })
    await appendFile(this.path(sessionId), `${JSON.stringify(line)}\n`, "utf8")
  }

  async create(input: CreateSessionInput) {
    const now = new Date().toISOString()
    const session: SessionRecord = {
      id: input.id ?? createID("session"),
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
    }
    if (input.title) session.title = input.title
    if (input.metadata) session.metadata = input.metadata
    await this.appendLine(session.id, { type: "session", session })
    return session
  }

  async appendMessage(input: Omit<SessionMessage, "id" | "createdAt"> & Partial<Pick<SessionMessage, "id" | "createdAt">>) {
    const session = await this.getSession(input.sessionId)
    if (!session) throw new PixiuError(`Unknown session: ${input.sessionId}`, { code: "SESSION_NOT_FOUND" })
    const message: SessionMessage = {
      id: input.id ?? createID("msg"),
      sessionId: input.sessionId,
      role: input.role,
      createdAt: input.createdAt ?? new Date().toISOString(),
      parts: input.parts,
    }
    await this.appendLine(input.sessionId, { type: "message", message })
    await this.appendLine(input.sessionId, { type: "update", patch: { updatedAt: message.createdAt } })
    return message
  }

  async getSession(id: string) {
    const parsed = await this.readFile(id)
    return parsed.session
  }

  async readMessages(sessionId: string) {
    return (await this.readFile(sessionId)).messages
  }

  async getTodos(sessionId: string) {
    return (await this.getTodoState(sessionId)).todos
  }

  async getTodoState(sessionId: string) {
    return (await this.readFile(sessionId)).todoState
  }

  async updateTodos(sessionId: string, todos: TodoItem[]) {
    const session = await this.getSession(sessionId)
    if (!session) throw new PixiuError(`Unknown session: ${sessionId}`, { code: "SESSION_NOT_FOUND" })
    await this.appendLine(sessionId, { type: "todo_state", state: todoStateFrom(todos) })
  }

  async listSessions() {
    await mkdir(this.rootDir, { recursive: true })
    const files = await readdir(this.rootDir)
    const sessions: SessionRecord[] = []
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const session = await this.getSession(file.slice(0, -".jsonl".length))
      if (session) sessions.push(session)
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async updateSession(sessionId: string, patch: Partial<SessionRecord>) {
    const session = await this.getSession(sessionId)
    if (!session) throw new PixiuError(`Unknown session: ${sessionId}`, { code: "SESSION_NOT_FOUND" })
    const next = { ...session, ...patch, updatedAt: new Date().toISOString() }
    await this.appendLine(sessionId, { type: "update", patch: next })
    return next
  }

  private async readFile(sessionId: string) {
    const path = this.path(sessionId)
    let content = ""
    try {
      content = await readFile(path, "utf8")
    } catch (cause: any) {
      if (cause?.code === "ENOENT") return { session: undefined, messages: [] as SessionMessage[], todoState: { todos: [] } as SessionTodoState }
      throw cause
    }

    let session: SessionRecord | undefined
    const messages: SessionMessage[] = []
    let todoState: SessionTodoState = { todos: [] }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index]
      if (!raw?.trim()) continue
      let line: SessionLine
      try {
        line = JSON.parse(raw) as SessionLine
      } catch (cause) {
        throw new PixiuError(`Invalid JSONL in ${path}:${index + 1}`, {
          code: "SESSION_JSONL_INVALID",
          cause,
        })
      }
      if (line.type === "session") session = line.session
      if (line.type === "message") messages.push(line.message)
      if (line.type === "update" && session) session = { ...session, ...line.patch }
      if (line.type === "todo_state") todoState = cloneTodoState(line.state)
    }
    return { session, messages, todoState }
  }
}

function todoStateFrom(todos: TodoItem[]): SessionTodoState {
  const currentTodo = todos.find((todo) => todo.status === "in_progress")
  return {
    todos: todos.map((todo) => ({ ...todo })),
    ...(currentTodo ? { currentTodoId: currentTodo.id } : {}),
  }
}

function cloneTodoState(state: SessionTodoState): SessionTodoState {
  return {
    todos: Array.isArray(state.todos) ? state.todos.map((todo) => ({ ...todo })) : [],
    ...(state.currentTodoId ? { currentTodoId: state.currentTodoId } : {}),
  }
}

export async function resetJsonlSessionStore(rootDir: string) {
  await mkdir(rootDir, { recursive: true })
  await writeFile(join(rootDir, ".keep"), "", "utf8")
}

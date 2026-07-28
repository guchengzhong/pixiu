import { createID } from "../shared/id"
import { PixiuError } from "../shared/errors"
import type { TodoItem } from "../todo/types"
import type { CreateSessionInput, SessionMessage, SessionRecord, SessionStore, SessionTodoState, SessionTurn } from "./types"

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly messages = new Map<string, SessionMessage[]>()
  private readonly turns = new Map<string, SessionTurn[]>()
  private readonly todos = new Map<string, SessionTodoState>()

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
    this.sessions.set(session.id, session)
    this.messages.set(session.id, [])
    this.turns.set(session.id, [])
    this.todos.set(session.id, { todos: [] })
    return session
  }

  async appendMessage(input: Omit<SessionMessage, "id" | "createdAt"> & Partial<Pick<SessionMessage, "id" | "createdAt">>) {
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new PixiuError(`Unknown session: ${input.sessionId}`, { code: "SESSION_NOT_FOUND" })
    const message: SessionMessage = {
      id: input.id ?? createID("msg"),
      sessionId: input.sessionId,
      role: input.role,
      createdAt: input.createdAt ?? new Date().toISOString(),
      parts: input.parts,
    }
    if (input.turnId) message.turnId = input.turnId
    this.messages.get(input.sessionId)!.push(message)
    session.updatedAt = message.createdAt
    return message
  }

  async getSession(id: string) {
    return this.sessions.get(id)
  }

  async readMessages(sessionId: string) {
    return [...(this.messages.get(sessionId) ?? [])]
  }

  async createTurn(turn: SessionTurn) {
    if (!this.sessions.has(turn.sessionId)) throw new PixiuError(`Unknown session: ${turn.sessionId}`, { code: "SESSION_NOT_FOUND" })
    const turns = this.turns.get(turn.sessionId) ?? []
    if (turns.some((item) => item.id === turn.id)) throw new PixiuError(`Turn already exists: ${turn.id}`, { code: "TURN_EXISTS" })
    turns.push({ ...turn })
    this.turns.set(turn.sessionId, turns)
    return { ...turn }
  }

  async updateTurn(sessionId: string, turnId: string, patch: Partial<SessionTurn>) {
    const turns = this.turns.get(sessionId) ?? []
    const index = turns.findIndex((turn) => turn.id === turnId)
    if (index < 0) throw new PixiuError(`Unknown turn: ${turnId}`, { code: "TURN_NOT_FOUND" })
    const current = turns[index]!
    const next = { ...current, ...patch, id: current.id, sessionId: current.sessionId, runId: current.runId }
    turns[index] = next
    return { ...next }
  }

  async readTurns(sessionId: string) {
    return (this.turns.get(sessionId) ?? []).map((turn) => ({ ...turn }))
  }

  async getTodos(sessionId: string) {
    return [...((await this.getTodoState(sessionId)).todos)]
  }

  async getTodoState(sessionId: string) {
    if (!this.sessions.has(sessionId)) return { todos: [] }
    const state = this.todos.get(sessionId)
    return state ? cloneTodoState(state) : { todos: [] }
  }

  async updateTodos(sessionId: string, todos: TodoItem[]) {
    if (!this.sessions.has(sessionId)) throw new PixiuError(`Unknown session: ${sessionId}`, { code: "SESSION_NOT_FOUND" })
    this.todos.set(sessionId, todoStateFrom(todos))
  }

  async listSessions() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async updateSession(sessionId: string, patch: Partial<SessionRecord>) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new PixiuError(`Unknown session: ${sessionId}`, { code: "SESSION_NOT_FOUND" })
    const updated = { ...session, ...patch, updatedAt: new Date().toISOString() }
    this.sessions.set(sessionId, updated)
    return updated
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
    todos: state.todos.map((todo) => ({ ...todo })),
    ...(state.currentTodoId ? { currentTodoId: state.currentTodoId } : {}),
  }
}

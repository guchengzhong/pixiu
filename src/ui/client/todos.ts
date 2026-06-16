import type { AgentEvent } from "../../agent/events"
import type { TodoItem, TodoStatus } from "../../todo/types"

export function normalizeTodos(todos: TodoItem[] | undefined): TodoItem[] {
  return todos ?? []
}

export function currentTodo(todos: readonly TodoItem[], currentTodoId?: string) {
  return (currentTodoId ? todos.find((todo) => todo.id === currentTodoId) : undefined) ?? todos.find((todo) => todo.status === "in_progress")
}

export function currentTodoIdFromTodos(todos: readonly TodoItem[], currentTodoId?: string) {
  return currentTodo(todos, currentTodoId)?.id
}

export function todoProgress(todos: readonly TodoItem[], currentTodoId?: string) {
  const completed = todos.filter((todo) => todo.status === "completed").length
  const inProgress = todos.filter((todo) => todo.status === "in_progress").length
  const pending = todos.filter((todo) => todo.status === "pending").length
  const cancelled = todos.filter((todo) => todo.status === "cancelled").length
  return {
    total: todos.length,
    completed,
    inProgress,
    pending,
    cancelled,
    current: currentTodo(todos, currentTodoId),
  }
}

export function todoMarker(status: TodoStatus) {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "●"
  if (status === "cancelled") return "×"
  return "○"
}

export function todoStatusClass(status: TodoStatus) {
  return `todo-item-${status.replace("_", "-")}`
}

export function todoUpdateMatchesSession(event: AgentEvent, sessionId: string | undefined): event is Extract<AgentEvent, { type: "todo_updated" }> {
  return event.type === "todo_updated" && sessionId !== undefined && event.sessionId === sessionId
}

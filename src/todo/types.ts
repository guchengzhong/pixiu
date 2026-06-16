export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export type TodoPriority = "high" | "medium" | "low"

export type TodoItem = {
  id: string
  content: string
  status: TodoStatus
  priority: TodoPriority
}

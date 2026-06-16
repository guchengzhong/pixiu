import type { TodoItem } from "../../../todo/types"
import { todoMarker, todoProgress, todoStatusClass } from "../todos"

export function TodoProgress({
  todos,
  currentTodoId,
  emptyText = "No task plan for this session yet.",
}: {
  todos: TodoItem[]
  currentTodoId: string | undefined
  emptyText?: string
}) {
  const summary = todoProgress(todos, currentTodoId)

  return (
    <section className="todo-progress" aria-label="Task progress">
      <div className="todo-progress-summary">
        <div>
          <span>Task Progress</span>
          {summary.total ? <strong>{summary.completed}/{summary.total} tasks</strong> : null}
        </div>
        {summary.current ? (
          <p className="current-task" title={summary.current.content}>
            <span>Current</span>
            {summary.current.content}
          </p>
        ) : null}
      </div>
      {todos.length ? (
        <div className="todo-list">
          {todos.map((todo) => (
            <div className={`todo-item ${todoStatusClass(todo.status)}`} key={todo.id}>
              <span className="todo-marker" aria-hidden="true">{todoMarker(todo.status)}</span>
              <span className="todo-content" title={todo.content}>{todo.content}</span>
              <span className="todo-priority">{todo.priority}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="todo-progress-empty">{emptyText}</div>
      )}
    </section>
  )
}

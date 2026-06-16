# 260616 Observability Layer TODO

## Goal

Make Pixiu's execution progress visible as structured session state instead of only showing raw tool calls. The first version should let CLI and Web UI answer:

- What task is Pixiu working on now?
- Which planned tasks are pending, in progress, completed, or cancelled?
- Which tool calls belong to the current run trace?
- Can a resumed session still show the latest progress state?

This slice should improve task observability without building a full plan-agent workflow yet.

## Current State

> Status note: Slices 1-6 are implemented and checked below. Slice 7 run status events and Slice 8 tool-authored `metadata.activity` are still pending.

- `src/agent/events.ts` exposes `assistant_progress_delta`, `tool_call`, `tool_result`, `message`, `error`, and `finish`, but no structured todo/progress event.
- `src/agent/runner.ts` treats all tool results the same. It does not promote todo output into session state.
- `src/tools/builtin.ts` has a `todo({ items: string[] })` tool that only echoes a compact list.
- `src/cli/trace.ts` renders progress notes and tool calls, but it has no durable task view.
- Web UI trace rendering in `src/ui/client/App.tsx` and `src/ui/client/components/TraceList.tsx` also treats progress and tool activity as plain trace entries.
- Session persistence stores messages, but there is no first-class todo list attached to a session.

## References

- `src/agent/events.ts`: agent event contract.
- `src/agent/runner.ts`: LLM loop and tool execution path.
- `src/tools/builtin.ts`: current built-in `todo` tool.
- `src/session/types.ts`: session store interfaces and message model.
- `src/session/jsonl.ts`: current session persistence implementation.
- `src/cli/trace.ts`: CLI trace renderer.
- `src/ui/client/App.tsx`: live SSE event handling.
- `src/ui/client/components/TraceList.tsx`: Web UI trace display.
- `code/opencode/packages/opencode/src/tool/todo.ts`: reference shape for `todowrite`.
- `code/opencode/packages/opencode/src/session/todo.ts`: reference persistence/event model.
- `code/opencode/packages/opencode/src/session/status.ts`: reference session status model.

## Slice 1: Upgrade Todo Tool Contract

- [x] Add a structured `todowrite` built-in tool.
  - [x] Input shape:
    - [x] `todos: TodoItem[]`
    - [x] `TodoItem.id?: string`
    - [x] `TodoItem.content: string`
    - [x] `TodoItem.status: "pending" | "in_progress" | "completed" | "cancelled"`
    - [x] `TodoItem.priority: "high" | "medium" | "low"`
  - [x] Treat each tool call as a complete todo-list snapshot, not an incremental patch.
  - [x] Generate stable ids for items that omit `id`.
  - [x] Preserve existing ids when the model sends them.
  - [x] Reject or normalize empty todo content.
  - [x] Validate that at most one todo is `in_progress`.
- [x] Return structured metadata from the tool result.
  - [x] `metadata.todos` contains normalized todo items.
  - [x] `content` remains human-readable for trace/debug output.
- [x] Keep backward compatibility for the old `todo({ items })` tool.
  - [x] Either keep `todo` as an alias that maps string items to pending todos.
  - [x] Or keep the old tool for one release while adding `todowrite` to the default agent tools.
  - [x] Update tests and prompt references to prefer `todowrite`.

## Slice 2: Promote Todos To Agent Events

- [x] Extend `AgentEvent` with a structured todo event.
  - [x] `type: "todo_updated"`
  - [x] `sessionId: string`
  - [x] `todos: TodoItem[]`
  - [x] Optional `currentTodoId?: string`
- [x] In `AgentRunner`, detect successful `todowrite` results.
  - [x] Save normalized todos as session state.
  - [x] Emit `todo_updated` immediately after the tool result.
  - [x] Continue emitting the normal `tool_result` for trace continuity.
- [ ] Consider a lightweight run status event only if it is needed by UI.
  - [ ] `run_started`
  - [ ] `run_idle`
  - [ ] `run_error`
  - [ ] Keep this separate from todo state.
- [x] Add tests proving event order.
  - [x] `tool_call` for `todowrite`
  - [x] `tool_result`
  - [x] `todo_updated`
  - [x] subsequent tool calls still render normally.

## Slice 3: Persist Session Todos

- [x] Add `TodoItem` to the session domain model.
  - [x] Define the type near session or agent shared types, not inside UI.
  - [x] Reuse the same type for tool metadata, `AgentEvent`, API responses, and UI state.
- [x] Extend `SessionStore` with todo state operations.
  - [x] `getTodos(sessionId): Promise<TodoItem[]>`
  - [x] `updateTodos(sessionId, todos): Promise<void>`
- [x] Persist todos in the JSONL session store.
  - [x] Prefer a small session metadata/state file if that fits the current store layout.
  - [x] Avoid project-level `.pixiu/todos.json` in this slice.
  - [x] Preserve existing sessions that do not have todo state.
- [x] Expose todos through existing session detail APIs.
  - [x] Loading or resuming a session should include the latest todo snapshot.
  - [x] Web UI should not need to replay all historical tool calls to recover the current todos.
- [x] Add tests.
  - [x] Todo state survives session reload.
  - [x] Existing sessions without todo state still load.
  - [x] Updating todos does not rewrite unrelated session messages.

## Slice 4: CLI Task View

- [x] Update `CliTraceRenderer` to handle `todo_updated`.
  - [x] Render a compact todo block when the list changes.
  - [x] Highlight the current `in_progress` item.
  - [x] Use stable status markers:
    - [x] `✓` completed
    - [x] `●` in progress
    - [x] `○` pending
    - [x] `×` cancelled
- [x] Keep the first implementation scroll-friendly.
  - [x] Do not require a full TUI or dynamic top-of-screen repaint.
  - [x] Print the changed todo snapshot above subsequent tool logs.
  - [x] Keep raw tool logs below the task view.
- [x] Avoid duplicate noise.
  - [x] Do not reprint the same todo list if unchanged.
  - [x] Do not print both old `todo` and new `todowrite` blocks for the same update.
- [x] Add CLI trace tests.
  - [x] New todo list prints a compact block.
  - [x] In-progress item is visible.
  - [x] Completed item is marked clearly.
  - [x] Tool trace output still appears after todo output.

## Slice 5: Web UI Progress State

- [x] Add todo state to client data types.
  - [x] Current todos for the selected session.
  - [x] Current in-progress todo.
  - [x] Completed count and total count.
- [x] Handle live `todo_updated` SSE events in `App.tsx`.
  - [x] Update session todo state immediately.
  - [x] Keep raw trace entry for `todowrite` collapsible in Activity.
- [x] Add a visible task progress surface.
  - [x] Center pane or top bar shows current task.
  - [x] Activity/inspector shows the full todo list.
  - [x] Completed/pending/in-progress states are visually distinct.
- [x] Restore todos when loading a saved session.
  - [x] Use session detail API state first.
  - [x] Fall back gracefully when older sessions have no todos.
- [x] Add UI/server tests where practical.
  - [x] Session detail includes todos.
  - [x] Live event updates client state.
  - [x] Trace still shows tool calls/results.

## Slice 6: Prompt And Agent Behavior

- [x] Update the default agent system prompt.
  - [x] For non-trivial tasks, create a todo list before substantial work.
  - [x] Mark exactly one item `in_progress` before working on it.
  - [x] Mark an item `completed` immediately after the required work and verification are done.
  - [x] Do not mark implementation tasks complete before tests/typecheck/build or a reasonable verification step.
  - [x] Add follow-up or blocker todos if the task becomes blocked or changes scope.
- [x] Keep prompt pressure proportional.
  - [x] Skip todo use for one-step informational or trivial tasks.
  - [x] Use todo for 3+ conceptual steps, multi-file edits, explicit user task lists, or risky changes.
- [x] Update fixtures/scenario tests so fake LLM flows can use `todowrite`.

## Slice 7: Optional Run Status Layer

Do this only after todo state is working and the UI proves it needs more lifecycle data.

- [ ] Add run/session status events.
  - [ ] `busy`
  - [ ] `idle`
  - [ ] `waiting_for_permission`
  - [ ] `error`
- [ ] Surface status in CLI and Web UI.
  - [ ] Current run busy/idle indicator.
  - [ ] Permission waiting state.
  - [ ] Retry/error state if provider failures are retried later.
- [ ] Keep status separate from todo state.
  - [ ] Todo says what work is being done.
  - [ ] Status says whether the run loop is active or blocked.

## Slice 8: Activity Metadata Contract

Move the Web UI Activity timeline from frontend guessing to tool-authored activity metadata. The current semantic timeline is useful as a deterministic fallback, but it still parses strings such as `Changed xxx.md` and shell commands. The more stable design is metadata-first: tools describe what they did at execution time, and the UI renders that directly.

### Goals

- [ ] Add a shared `ActivityMetadata` type outside the UI directory.
  - [ ] Suggested shape:
    - [ ] `kind: "file.read" | "file.write" | "file.edit" | "shell.command" | "web.search" | "web.fetch" | "skill.load" | "todo.update" | "artifact.create" | "unknown"`
    - [ ] `title: string`
    - [ ] `target?: string`
    - [ ] `summary?: string`
    - [ ] `status?: "running" | "success" | "failed" | "blocked"`
    - [ ] `detail?: string`
- [ ] Allow tool results to include `metadata.activity?: ActivityMetadata`.
  - [ ] Keep existing `metadata` fields intact.
  - [ ] Do not remove raw `content`.
  - [ ] Do not require a new backend route or a new run API.
- [ ] Update built-in tools to emit activity metadata.
  - [ ] `read`: `kind=file.read`, `title=Read file`, `target=path`.
  - [ ] `write`: `kind=file.write`, `title=Updated file` or `Wrote file`, `target=path`.
  - [ ] `edit` / `patch`: `kind=file.edit`, `title=Updated file`, `target=path`.
  - [ ] `web_search`: `kind=web.search`, `title=Searched web`, `target=query`.
  - [ ] `web_fetch`: `kind=web.fetch`, `title=Fetched page`, `target=url`.
  - [ ] `skill`: `kind=skill.load`, `title=Loaded skill`, `target=name`.
  - [ ] `todowrite` / legacy `todo`: `kind=todo.update`, `title=Updated task plan`.
  - [ ] Artifact-producing tools should set `kind=artifact.create` where the tool can identify the artifact.
- [ ] Keep raw details fully auditable.
  - [ ] Raw tool input JSON remains available.
  - [ ] Raw tool result `content`, stdout/stderr, exit code, and metadata remain available.
  - [ ] UI should show metadata activity by default but keep raw details collapsible.

### Shell Purpose And Activity

Shell is special because the command string alone is not always enough to know the user's intent.

- [ ] Extend the shell tool input schema with optional `purpose?: string`.
  - [ ] Example:
    - [ ] `command: "wc -l .pixiu/tmp/paper_text.txt"`
    - [ ] `purpose: "Count lines in the extracted paper text"`
  - [ ] Treat `purpose` as agent-declared intent, not verified fact.
  - [ ] Keep the raw command visible in Activity raw details.
- [ ] Emit shell `metadata.activity`.
  - [ ] Default:
    - [ ] `kind=shell.command`
    - [ ] `title=Command completed` / `Command failed`
    - [ ] `target=command` or identified output path
    - [ ] `status=success|failed`
  - [ ] If `purpose` is present, use it as the primary human-readable title or summary.
  - [ ] If the command has reliable deterministic metadata, set target:
    - [ ] Redirect output path: `> output_path`
    - [ ] Known command target path when safe to parse
  - [ ] Do not claim business intent from command parsing unless it is obvious and deterministic.

### UI Priority Order

Update the Web UI timeline derivation to use this priority order:

1. [ ] Prefer `tool_result.metadata.activity`.
2. [ ] If unavailable, use `tool_call.input.purpose` or `tool_call.input.summary` when present.
3. [ ] If unavailable, use the current deterministic frontend heuristic.
4. [ ] Fallback to generic labels:
   - [ ] `Command completed`
   - [ ] `Command failed`
   - [ ] `Running command`
   - [ ] `Tool completed`

The existing `deriveExecutionTimeline(trace)` heuristic should remain as a compatibility fallback for older sessions and tools that do not yet emit activity metadata.

### Frontend Trace Requirements

- [ ] Preserve tool result metadata in the UI trace model.
  - [ ] Current live UI trace mainly stores title/detail/kind/failed.
  - [ ] Add frontend-internal trace fields if needed, such as `metadata?: JsonObject` or `raw?: unknown`.
  - [ ] Do not change shared UI API types unless required for already-exposed session detail.
- [ ] Preserve restored-session metadata.
  - [ ] `traceFromMessages()` should extract `tool_result.result.metadata.activity` from persisted messages.
  - [ ] Live SSE `tool_result` handling should preserve `event.metadata`.
- [ ] Keep old sessions working.
  - [ ] If metadata is missing, semantic timeline should still use deterministic heuristics.

### Tests

- [ ] Tool tests:
  - [ ] `read` returns `metadata.activity.kind=file.read`.
  - [ ] `write` returns `metadata.activity.kind=file.write` and target path.
  - [ ] `edit` / `patch` return `metadata.activity.kind=file.edit`.
  - [ ] `shell` returns `metadata.activity.kind=shell.command` with status.
  - [ ] `shell` accepts optional `purpose` and includes it in activity summary/title.
  - [ ] `web_search` / `web_fetch` activity metadata includes query/url.
  - [ ] `todowrite` activity metadata is `todo.update`.
- [ ] Runner/UI tests:
  - [ ] `tool_result` AgentEvent continues to include metadata.
  - [ ] Live Web UI trace preserves `metadata.activity`.
  - [ ] Restored session trace preserves `metadata.activity`.
  - [ ] Timeline uses metadata before heuristic.
  - [ ] Missing metadata falls back to existing heuristic.
  - [ ] Raw details remain expandable.

### Non-goals

- [ ] No LLM-based activity summarization.
- [ ] No new server route.
- [ ] No run API or message schema redesign beyond existing metadata.
- [ ] No hidden chain-of-thought display.
- [ ] No removal of current deterministic frontend heuristics until old sessions are safely covered.

## Suggested Order

1. Add shared `TodoItem` type and structured `todowrite` tool.
2. Add `todo_updated` event and runner promotion logic.
3. Persist todos on the session store.
4. Update CLI trace rendering.
5. Update Web UI live and restored todo state.
6. Strengthen the default prompt and tests.
7. Add richer run status only if needed.
8. Add tool-authored `metadata.activity` and make the UI metadata-first.

## Non-goals

- No full plan-agent workflow in this slice.
- No project-level todo database yet.
- No hidden chain-of-thought or reasoning display.
- No dynamic terminal TUI rewrite before the scroll-friendly CLI view works.
- No broad session storage migration beyond backward-compatible todo state.
- No automatic remote sync or sharing of todos.

## Verification

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test test/tools test/agent test/session test/cli/trace.test.ts
PATH=.tools/bun/bin:$PATH bun test test/ui
```

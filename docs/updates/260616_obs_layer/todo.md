# 260616 Observability Layer TODO

## Goal

Make Pixiu's execution progress visible as structured session state instead of only showing raw tool calls. The first version should let CLI and Web UI answer:

- What task is Pixiu working on now?
- Which planned tasks are pending, in progress, completed, or cancelled?
- Which tool calls belong to the current run trace?
- Can a resumed session still show the latest progress state?

This slice should improve task observability without building a full plan-agent workflow yet.

## Current State

> Status note (2026-06-18): Slices 1-7 are implemented. Slices 8-9 were completed through the later `260617_tools_use` Slice 8 alignment. The early dotted activity kind proposal was intentionally replaced by the current shared coarse `ActivityKind` model plus optional `details.operation` metadata.

- `src/agent/events.ts` exposes `todo_updated` in addition to assistant progress, tool, message, error, and finish events.
- `src/agent/runner.ts` promotes successful `todowrite` and legacy `todo` metadata into session todo state.
- `src/tools/builtin.ts` includes structured `todowrite`, keeps the legacy `todo` path, and emits `metadata.activity` for built-in operations.
- `src/run/status.ts` defines the current run status model: `queued | running | waiting_for_permission | idle | error | cancelled`.
- `src/activity/types.ts` and `src/activity/format.ts` define shared semantic activity types and formatting for CLI and Web UI.
- `src/cli/trace.ts` renders todo snapshots and semantic CodeBuddy-style tool activity while keeping raw details available in verbose output.
- Web UI state uses live `todo_updated`, `run_status`, and `activity_updated` events and restores persisted todos/activity from session detail.

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
- [x] Consider a lightweight run status event only if it is needed by UI.
  - [x] Implemented later as `run_status` SSE events with `queued`, `running`, `waiting_for_permission`, `idle`, `error`, and `cancelled`.
  - [x] Keep this separate from todo state.
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

- [x] Add run/session status events.
  - [x] Current statuses are `queued`, `running`, `waiting_for_permission`, `idle`, `error`, and `cancelled`.
  - [x] Keep legacy `run` SSE compatibility values such as `waiting_permission` and `done`.
  - [x] Keep terminal persisted status normalized to `idle`, `error`, or `cancelled`.
- [x] Surface status in CLI and Web UI.
  - [x] Web UI consumes `run_status` SSE events.
  - [x] Web UI shows current run status labels in the top bar, composer, status panel, and structured cards.
  - [x] CLI chat has local run progress/status while the runner is active.
  - [x] Permission waiting state is surfaced as `waiting_for_permission`.
  - [x] Provider failures and cancellations surface as terminal `error` / `cancelled` status.
- [x] Keep status separate from todo state.
  - [x] Todo says what work is being done.
  - [x] Status says whether the run loop is active or blocked.
  - [x] Activity timeline does not use run lifecycle statuses as semantic activity.

## Slice 8: Activity Metadata Contract

Move the Web UI Activity timeline from frontend guessing to tool-authored activity metadata. The current semantic timeline is useful as a deterministic fallback, but it still parses strings such as `Changed xxx.md` and shell commands. The more stable design is metadata-first: tools describe what they did at execution time, and the UI renders that directly.

Status: implemented through `260617_tools_use` Slice 8. The implementation reuses the shared activity model instead of the early dotted enum sketch below. Public `kind` values are coarse categories such as `file`, `shell`, `search`, `skill`, `artifact`, and `system`; finer operations can live in `details.operation`.

### Goals

- [x] Add a shared `ActivityMetadata` type outside the UI directory.
  - [x] Implemented in `src/activity/types.ts`.
  - [x] Uses shared `ActivityKind` coarse values instead of dotted enum strings.
  - [x] Supports `title`, `target`, `summary`, `status`, `command`, and `details`.
- [x] Allow tool results to include `metadata.activity?: ActivityMetadata`.
  - [x] Keep existing `metadata` fields intact.
  - [x] Do not remove raw `content`.
  - [x] Do not require a new backend route or a new run API.
- [x] Update built-in tools to emit activity metadata.
  - [x] `read`: `kind=file`, `title=Read file`, `target=path`.
  - [x] `write`: `kind=file`, `title=Updated file` or `Wrote file`, `target=path`.
  - [x] `edit` / `patch`: `kind=file`, `title=Updated file`, `target=path`.
  - [x] `web_search`: `kind=search`, `title=Searched web`, `target=query`.
  - [x] `web_fetch`: `kind=search`, `title=Fetched page`, `target=url`.
  - [x] `skill`: `kind=skill`, `title=Loaded skill`, `target=name`.
  - [x] `todowrite` / legacy `todo`: `kind=system`, `title=Updated task plan`.
  - [x] Artifact-producing tools set `kind=artifact` where the tool can identify the artifact.
- [x] Keep raw details fully auditable.
  - [x] Raw tool input JSON remains available.
  - [x] Raw tool result `content`, stdout/stderr, exit code, and metadata remain available.
  - [x] UI shows semantic activity by default while keeping raw details available.

### Shell Purpose And Activity

Shell is special because the command string alone is not always enough to know the user's intent.

- [x] Extend the shell tool input schema with optional `purpose?: string`.
  - Example:
    - `command: "wc -l .pixiu/tmp/paper_text.txt"`
    - `purpose: "Count lines in the extracted paper text"`
  - [x] Treat `purpose` as agent-declared intent, not verified fact.
  - [x] Keep the raw command visible in Activity raw details.
- [x] Emit shell `metadata.activity`.
  - [x] Default:
    - [x] `kind=shell`
    - [x] `title=Ran command` / `Command failed`, or the provided semantic purpose.
    - [x] `command=command`
    - [x] `status=success|error`
  - [x] If `purpose` is present, use it as the primary human-readable title or summary.
  - [x] Include deterministic metadata such as exit code, timeout, and duration in `details`.
  - [x] Do not claim business intent from command parsing unless it is obvious and deterministic.

### UI Priority Order

Update the Web UI timeline derivation to use this priority order:

1. [x] Prefer `tool_call.input._activity` when present, then update it with `tool_result.metadata.activity`.
2. [x] If unavailable, use `tool_result.metadata.activity`.
3. [x] If unavailable, use `tool_call.input.purpose` or deterministic semantic input when present.
4. [x] If unavailable, use the current deterministic heuristic.
5. [x] Fallback to generic labels:
   - [x] `Ran command`
   - [x] `Command failed`
   - [x] `Running command`
   - [x] `Used tool: <name>`

The existing `deriveExecutionTimeline(trace)` heuristic should remain as a compatibility fallback for older sessions and tools that do not yet emit activity metadata.

### Frontend Trace Requirements

- [x] Preserve tool result metadata in the UI trace model.
  - [x] Live raw trace still contains tool call input and tool result metadata.
  - [x] Shared UI API exposes semantic activity items and raw trace details.
  - [x] No new route was required for this.
- [x] Preserve restored-session metadata.
  - [x] Restored sessions recover persisted semantic activity.
  - [x] Live SSE `tool_result` handling preserves `event.metadata`.
- [x] Keep old sessions working.
  - [x] If metadata is missing, semantic timeline still uses deterministic heuristics.

### Tests

- [x] Tool tests:
  - [x] `read` returns `metadata.activity.kind=file`.
  - [x] `write` returns `metadata.activity.kind=file` and target path.
  - [x] `edit` / `patch` return `metadata.activity.kind=file`.
  - [x] `shell` returns `metadata.activity.kind=shell` with status.
  - [x] `shell` accepts optional `purpose` and includes it in activity summary/title.
  - [x] `web_search` / `web_fetch` activity metadata includes query/url.
  - [x] `todowrite` activity metadata is `kind=system` with todo/update semantics.
- [x] Runner/UI tests:
  - [x] `tool_result` AgentEvent continues to include metadata.
  - [x] Live Web UI trace preserves `metadata.activity`.
  - [x] Restored session trace preserves `metadata.activity`.
  - [x] Timeline uses intent/metadata before heuristic.
  - [x] Missing metadata falls back to existing heuristic.
  - [x] Raw details remain expandable.

### Non-goals

- [x] No LLM-based activity summarization.
- [x] No new server route.
- [x] No run API or message schema redesign beyond existing metadata.
- [x] No hidden chain-of-thought display.
- [x] No removal of current deterministic frontend heuristics until old sessions are safely covered.

## Slice 9: CLI Semantic Trace Rendering

The Web UI Activity panel now has a metadata-first semantic activity path, but interactive CLI chat still renders many tool calls as raw developer traces such as:

```text
● Bash(agent-reach doctor --json)
  ⎿ ✗ Bash failed exit=127 · 2.1 s
```

That is useful for debugging, but it is not friendly as the default user-facing progress surface. The CLI should show a task-oriented activity stream by default while preserving raw commands under verbose/debug output.

Status: implemented. `CliTraceRenderer` now uses the shared semantic activity formatter for CodeBuddy-style chat output while keeping compact trace output and raw verbose details available.

### Goals

- [x] Make CLI chat consume the same semantic activity model used by the Web UI.
  - [x] Reuse `activityFromToolIntent()`, `activityFromToolResult()`, and `updateActivityWithToolResult()` where practical.
  - [x] Avoid creating a separate CLI-only semantic model that diverges from UI behavior.
  - [x] Keep raw command and result content auditable.
- [x] Replace raw shell-first labels with intent-first labels in codebuddy-style chat output.
  - [x] Prefer user-facing titles such as `检查 Agent Reach 可用状态`.
  - [x] Avoid defaulting to `Bash(command)` when a semantic title is available.
  - [x] Avoid defaulting to `Completed bash command` / `Bash failed` when a semantic result title is available.
- [x] Preserve developer ergonomics.
  - [x] `--verbose` shows raw command details, stdout/stderr preview, exit code, and timing.
  - [x] JSON / stream-json output remains raw and machine-readable.
  - [x] Compact non-chat trace output remains readable and backward-compatible unless explicitly changed.

### Shell Purpose

Shell is the biggest source of noisy output. Add a simple intent field to the shell tool input:

```ts
purpose?: string
```

Example model call:

```json
{
  "command": "agent-reach doctor --json",
  "purpose": "检查 Agent Reach 可用状态"
}
```

Expected behavior:

```text
● 检查 Agent Reach 可用状态
  ⎿ ✗ Agent Reach 未安装 · 2.1 s
```

Instead of:

```text
● Bash(agent-reach doctor --json)
  ⎿ ✗ Bash failed exit=127 · 2.1 s
```

Tasks:

- [x] Extend shell input schema with optional `purpose`.
  - [x] Treat `purpose` as model-declared intent, not verified fact.
  - [x] Preserve raw `command` in metadata and verbose output.
  - [x] Do not pass `purpose` to the shell process.
- [x] Include `purpose` in shell `metadata.activity`.
  - [x] Use it as `activity.title` or `activity.summary`.
  - [x] Keep `activity.command` as the raw command.
  - [x] Keep deterministic metadata such as `exitCode`, `timedOut`, and `durationMs`.
- [x] Update the system prompt examples.
  - [x] Show `purpose` for shell calls.
  - [x] Keep `_activity` supported for richer structured cases.
  - [x] Include an Agent Reach example:

```json
{
  "command": "agent-reach doctor --json",
  "purpose": "检查 Agent Reach 可用状态",
  "_activity": {
    "kind": "shell",
    "title": "检查 Agent Reach 可用状态"
  }
}
```

### CLI Rendering Priority

Update `CliTraceRenderer` display priority for `tool_call` and `tool_result`.

For `tool_call`, use:

1. `tool_call.input._activity.title`
2. `shell input purpose`
3. deterministic command intent fallback
4. current compact tool label
5. raw `Bash(command)` only as last resort or verbose detail

For `tool_result`, use:

1. `tool_result.metadata.activity.title` / semantic status
2. matched prior intent from the active tool call
3. deterministic command result fallback
4. current raw result summary

Suggested default output:

```text
● 加载 Agent Reach 能力说明
  ⎿ ✓ 已加载 agent-reach
● 检查 Agent Reach 可用状态
  ⎿ ✗ Agent Reach 未安装 · 2.1 s
● 准备小红书查询工具
  ⎿ ✓ 已安装 xhs-cli
```

Suggested verbose output can append or reveal:

```text
raw: agent-reach doctor --json
exit: 127
stderr: /bin/sh: 1: agent-reach: not found
```

### Deterministic Shell Intent Fallbacks

Do not try to infer arbitrary business intent from shell commands. Add only obvious, stable command recognizers.

Suggested first recognizers:

- [x] `agent-reach doctor --json` -> `检查 Agent Reach 可用状态`
- [x] `agent-reach install --env=auto --safe` -> `预检 Agent Reach 安装`
- [x] `agent-reach install --env=auto --dry-run` -> `预览 Agent Reach 安装`
- [x] `agent-reach install ...` -> `安装 Agent Reach`
- [x] `agent-reach check-update` -> `检查 Agent Reach 更新`
- [x] `pipx install xhs-cli` / `pip3 install ... xhs-cli` -> `安装小红书命令行工具`
- [x] `python3 -m venv ...` -> `创建临时 Python 环境`
- [x] `which agent-reach` / `command -v agent-reach` -> `检查 Agent Reach 命令`
- [x] `which pipx` / `command -v pipx` -> `检查 pipx 命令`
- [x] `xhs hot` -> `获取小红书热门话题`
- [x] `xhs search ...` -> `搜索小红书内容`
- [x] `opencli xiaohongshu ...` -> `使用 OpenCLI 访问小红书`
- [x] `bili search ...` -> `搜索 Bilibili 视频`
- [x] `yt-dlp ...` -> `读取 YouTube 视频信息`

Fallback rules:

- [x] If the command is not confidently recognized, keep a generic semantic label such as `运行命令` rather than inventing an intent.
- [x] Keep the raw command available under verbose output.
- [x] Never hide failures. Friendly labels should still make errors clear.

### Tests

- [x] CLI trace tests:
  - [x] `shell` call with `purpose` renders the purpose instead of `Bash(command)`.
  - [x] `shell` result with `metadata.activity` renders semantic title/status.
  - [x] `agent-reach doctor --json` fallback renders `检查 Agent Reach 可用状态`.
  - [x] Failed `agent-reach doctor --json` with exit 127 renders an Agent Reach missing-style message, not only `Bash failed`.
  - [x] `--verbose` or verbose renderer still includes raw command details.
  - [x] Existing non-semantic tool traces remain readable.
- [x] Tool tests:
  - [x] Shell schema accepts `purpose`.
  - [x] Shell execution ignores `purpose` for process invocation.
  - [x] Shell result metadata includes both `command` and semantic `activity`.
- [x] Prompt tests:
  - [x] Shell examples mention `purpose`.
  - [x] `_activity` examples remain valid.

### Non-goals

- [x] No LLM-based summarization of arbitrary shell commands.
- [x] No removal of raw command data.
- [x] No change to JSON / stream-json event contracts beyond existing tool input/metadata additions.
- [x] No full dynamic terminal TUI.
- [x] No attempt to make every command perfectly human-readable in the first version.

## Suggested Order

1. Add shared `TodoItem` type and structured `todowrite` tool.
2. Add `todo_updated` event and runner promotion logic.
3. Persist todos on the session store.
4. Update CLI trace rendering.
5. Update Web UI live and restored todo state.
6. Strengthen the default prompt and tests.
7. Add richer run status only if needed.
8. Add tool-authored `metadata.activity` and make the UI metadata-first.
9. Make CLI chat consume semantic activity metadata and shell `purpose`.

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

# 260605 MCP TODO

## Goal

Harden minicode's MCP layer from "best-effort tool import" into a diagnosable external capability boundary. Broken MCP servers should be visible, disabled servers should be explicit, and imported tools should be safe and deterministic.

## First Slice: Status And Tool Import Baseline

- [x] Add MCP status model
  - [x] `connected` with tool count and tool names.
  - [x] `failed` with a short error summary.
  - [x] `disabled` for config entries with `enabled: false`.
- [x] Improve CLI status
  - [x] `minicode mcp list` prints server name, status, tool count, and error summary.
  - [x] `minicode mcp list --json` exposes structured status.
  - [x] `minicode mcp test <name>` uses the same client creation path as runtime.
- [x] Harden stdio MCP lifecycle
  - [x] Reject pending requests when the child exits or errors.
  - [x] Capture bounded stderr and include it in failure messages.
  - [x] Close child processes with terminate/kill fallback.
  - [x] Clean pending requests on timeout.
- [x] Harden MCP tool conversion
  - [x] Sanitize imported tool names.
  - [x] Detect sanitized name collisions and fail with a clear error.
  - [x] Normalize missing or invalid input schemas to an object schema.
  - [x] Keep original MCP tool name in metadata.
- [x] Add tests
  - [x] Fake stdio MCP list/call still works.
  - [x] Fake HTTP MCP list still works.
  - [x] Bad MCP server does not hide built-in tools.
  - [x] Stdio timeout is surfaced.
  - [x] Tool name collision is detected.
  - [x] CLI status shows connected/failed/disabled.

## Non-goals

- No OAuth/auth flow yet.
- No prompts/resources yet.
- No `mcp add/auth/logout/debug` commands yet.
- No real third-party MCP server smoke by default.

## Verification

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
```

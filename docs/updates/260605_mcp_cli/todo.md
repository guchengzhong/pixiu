# 260605 MCP CLI TODO

## Goal

Make MCP a first-class CLI-managed capability surface. Users should be able to add, inspect, disable, re-enable, and remove MCP servers without hand-editing `minicode.jsonc`.

This follows the useful part of opencode's MCP CLI direction while staying aligned with minicode's current runtime. Harness remains test infrastructure, not a user-facing configuration area.

## First Slice: Configuration Lifecycle

- [x] Add CLI commands
  - [x] `minicode mcp add stdio <name> -- <command> [args...]`
  - [x] `minicode mcp add http <name> <url>`
  - [x] `minicode mcp remove <name>`
  - [x] `minicode mcp enable <name>`
  - [x] `minicode mcp disable <name>`
  - [x] `minicode mcp doctor [--json]`
- [x] Keep commands automation-friendly
  - [x] Support `--json` for config mutation commands.
  - [x] Avoid accidental overwrite unless `--yes` is provided.
  - [x] Validate names, transports, URLs, timeout values, env/header pairs.
- [x] Improve diagnostics
  - [x] `mcp doctor` should summarize configured, connected, failed, and disabled servers.
  - [x] Non-JSON output should remain readable for terminal users.
  - [x] JSON output should expose enough structure for tests and scripts.
- [x] Update docs
  - [x] Usage examples for local stdio and HTTP MCP servers.
  - [x] Main TODO progress note.
- [x] Add tests
  - [x] Add stdio config through CLI.
  - [x] Add HTTP config through CLI.
  - [x] Reject duplicate add without `--yes`.
  - [x] Enable, disable, remove update `minicode.jsonc`.
  - [x] Doctor reports connected, failed, disabled counts.

## Non-goals

- No OAuth/auth/logout flow yet.
- No remote MCP token store yet.
- No prompts/resources CLI yet.
- No user-facing harness config command.

## Verification

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
```

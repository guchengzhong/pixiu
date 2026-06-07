# 260606 CodeBuddy CLI TODO

## Goal

Evolve minicode's CLI from a bare agent runner into a polished coding-assistant terminal experience inspired by CodeBuddy Code.

The goal is not to copy CodeBuddy's brand or every product feature. The goal is to borrow the parts that make the CLI feel legible, trustworthy, and pleasant:

- clear startup context
- good interactive chat ergonomics
- readable streaming output
- visible tool progress
- understandable permission and provider errors
- useful command organization
- stable non-interactive output for scripts

## Initial Judgment

This is a reasonable direction. minicode already has the hard inner loop: config, sessions, LLM streaming, tools, permissions, sandbox, MCP, and skills. The ugly part is mostly the CLI surface.

Implementation difficulty:

- Easy to medium for `run`/`doctor`/`tool list` output polish.
- Medium for interactive `chat` quality, because line editing, slash commands, prompt history, multiline input, and Ctrl-C behavior need care.
- Medium for permission UX, because current permissions are non-interactive and mostly hidden in tool metadata.
- Hard only if we try to clone CodeBuddy's full TUI/Web UI/daemon/worktree/swarm feature set. Those should stay out of the first slice.

Recommended approach: make minicode feel product-grade in the terminal first, without making the core larger than necessary.

## CodeBuddy Behaviors Worth Borrowing

- [x] Startup panel
  - [x] Show product name and version.
  - [x] Show a small ASCII/ANSI logo or compact identity block.
  - [x] Show tips for getting started.
  - [x] Show recent activity or "No recent activity".
  - [x] Show provider/model, permission mode, cwd, and session/workspace path.
  - [x] Keep this optional or only for interactive `chat`, so `run` remains script-friendly.
  - [x] Consider showing a local Web UI placeholder/link only if minicode later grows `serve` (deferred until minicode has a real `serve` command).
- [x] Prompt styling
  - [x] Use a visible prompt marker like `>`.
  - [x] Echo user input in a compact highlighted style in interactive mode.
  - [x] Treat `exit` and `quit` as real exits.
  - [x] Treat Ctrl-D as a real exit.
  - [x] Make Ctrl-C behavior explicit: first Ctrl-C cancels/clears, second Ctrl-C exits.
  - [x] Show a short status hint like `? for shortcuts`.
  - [x] Show model/status text on the right when terminal width allows.
  - [x] Avoid leaking model reasoning or draft protocol text into the default user view.
- [x] Response formatting
  - [x] Stream final assistant text cleanly.
  - [x] In text mode, print only the final answer by default.
  - [x] Render Markdown reasonably in terminal: bullets, code blocks, headings, tables when practical.
  - [x] Add color only when stdout is a TTY.
  - [x] Disable color with `NO_COLOR` or `--no-color`.
- [x] Tool trace rendering
  - [x] Replace raw-ish trace lines with readable status rows.
  - [x] Show tool name, concise action, target path/command, duration, and success/failure.
  - [x] Show failed tool previews with redacted output.
  - [x] Collapse noisy successful tool output by default.
  - [x] Add a verbose mode to show full tool inputs/results.
  - [x] Keep thinking/reasoning hidden by default, but optionally expose it in verbose or JSON modes.
- [x] Command organization
  - [x] Add `-p` / `--print` as an alias for non-interactive `run`.
  - [x] Add `--output-format text|json|stream-json` while keeping current `--json` as an alias.
  - [x] Add `-c` / `--continue` for the most recent session.
  - [x] Keep `--session <id>` for exact resume.
  - [x] Add `config get/set/list` instead of only `config validate`.
  - [x] Make existing `mcp`, `skill`, and `session` list output more consistent.
  - [x] Group existing command help more consistently.
- [x] Better diagnostics
  - [x] Make missing provider API key a friendly auth/provider panel.
  - [x] Show which env var is expected.
  - [x] Suggest `minicode config validate` and a minimal provider config example.
  - [x] Add `doctor` checks for Bun, provider key presence, config validity, workspace writability, MCP status, and skills path status.
  - [x] Add a Node availability check if Node becomes a supported runtime requirement (not required now; minicode is Bun-first and has a Bun doctor check).
- [x] Permission UX
  - [x] Surface permission mode at startup.
  - [x] Surface permission mode immediately before risky actions.
  - [x] Add `--permission-mode default|acceptEdits|bypassPermissions|plan` or a smaller minicode-native equivalent.
  - [x] Keep `--yes` as an alias for bypassing `ask` rules in non-interactive runs.
  - [x] In interactive `chat`, support a real ask/approve prompt for high-risk tools.
  - [x] Show why a tool was denied using the existing permission metadata.
- [x] Session UX
  - [x] Show session id in startup and finish output.
  - [x] Show workspace path in a compact way.
  - [x] Add `session resume` or improve `session list` to mark the latest session.
  - [x] Add a recent activity section backed by session metadata.
- [x] Headless/script mode
  - [x] Preserve stable machine-readable JSONL event output.
  - [x] Add `stream-json` output that mirrors realtime agent events.
  - [x] Add an initial `system/init` event with session id, cwd, tools, model, permission mode, MCP servers, and available slash commands.
  - [x] Add a final `result` event with success/error, final text, session id, duration, turns, token usage, and permission denials.
  - [x] For `json` output, return the full event array or a single structured result; document the choice clearly.
  - [x] Ensure no startup panel, colors, tips, or spinners pollute non-TTY/script output unless requested.
  - [x] Make exit codes meaningful for provider errors, tool denial, max steps, and config errors.

## First Slice: CLI Renderer Refresh

- [x] Add a small terminal formatting module
  - [x] TTY detection.
  - [x] ANSI color helpers.
  - [x] `NO_COLOR` support.
  - [x] Box/divider helpers that degrade cleanly without color.
- [x] Redesign `CliTraceRenderer`
  - [x] Use concise labels for `read`, `grep`, `glob`, `shell`, `write`, `edit`, `patch`, `skill`, and MCP tools.
  - [x] Include duration and byte counts only where useful.
  - [x] Hide successful output by default.
  - [x] Keep failure previews.
  - [x] Add tests for trace rendering snapshots.
- [x] Improve final answer streaming
  - [x] Print a clean newline before and after the final answer.
  - [x] Avoid duplicated text when streaming.
  - [x] Keep `FINAL:` stripped from user-facing output.
- [x] Add CLI flags
  - [x] `--no-color`
  - [x] `--verbose`
  - [x] `-p` / `--print`
  - [x] `--output-format text|json|stream-json`
- [x] Update docs
  - [x] Refresh `docs/usage.md` with the new flags.
  - [x] Explain TTY vs non-TTY output behavior.

## Second Slice: Interactive Chat Upgrade

- [x] Startup panel for `minicode chat`
  - [x] Version.
  - [x] Provider/model.
  - [x] Permission mode.
  - [x] Cwd.
  - [x] Current or new session id.
  - [x] Recent activity.
  - [x] Short tips.
  - [x] Two-column layout when width allows; compact vertical layout on narrow terminals (kept as a compact boxed layout for now to avoid full TUI complexity).
  - [x] Bordered panel with a subdued divider between identity and status details.
- [x] Better input loop
  - [x] `exit` and `quit` exit cleanly.
  - [x] Ctrl-D exits cleanly.
  - [x] Ctrl-C cancels the current run if one is active.
  - [x] Double Ctrl-C exits from idle input.
  - [x] Optional multiline input support.
  - [x] Keep prompt history when possible.
  - [x] Do not trap the user in an unfinished multiline buffer; provide a visible reset shortcut.
- [x] Slash commands
  - [x] `/help`
  - [x] `/clear`
  - [x] `/paste`
  - [x] `/session`
  - [x] `/model`
  - [x] `/tools`
  - [x] `/mcp`
  - [x] `/skills`
  - [x] `/doctor`
- [x] Interactive permission prompt
  - [x] Ask before risky `shell`, `write`, `edit`, and `patch` calls when permission action is `ask`.
  - [x] Allow once.
  - [x] Deny once.
  - [x] Consider "allow for this session" as a later enhancement.

## Third Slice: Doctor, Config, and Help Polish

- [x] Improve `minicode --help`
  - [x] Group commands by purpose.
  - [x] Include common examples.
  - [x] Mention `-p`, `--output-format`, `--yes`, and `--session`.
- [x] Expand `doctor`
  - [x] Check config file location and validity.
  - [x] Check provider key env var without printing secret values.
  - [x] Check Bun availability.
  - [x] Check session directory writability.
  - [x] Check workspace directory writability.
  - [x] Check skills paths.
  - [x] Check MCP servers and summarize failures.
- [x] Add config commands
  - [x] `config list`
  - [x] `config get <key>`
  - [x] `config set <key> <value>`
  - [x] Preserve JSONC comments if practical, or document that config writes normalize the file.
- [x] Improve list commands
  - [x] `tool list` with table layout.
  - [x] `skill list` with source/path columns.
  - [x] `mcp list` with status, transport, tool count, and error summary.
  - [x] `session list` with latest marker and title.

## Fourth Slice: CodeBuddy-Like Features To Defer

- [x] Web UI (deferred)
  - CodeBuddy exposes a local Web UI. minicode can defer this until the terminal flow is good.
- [x] Daemon/background sessions (deferred)
  - Useful, but not needed for the first CLI polish pass.
- [x] Worktree mode (deferred)
  - Useful for coding agents, but should come after interactive permissions and session UX.
- [x] Sub-agents/team mode (deferred)
  - minicode's core should stay small until single-agent UX feels solid.
- [x] Full terminal TUI framework (deferred)
  - Avoid pulling in a heavy TUI dependency until simple ANSI/readline improvements hit their limit.

## Compatibility Requirements

- [x] Do not break current `minicode run "message"` usage.
- [x] Do not break `--json`; keep it as an alias or compatibility mode.
- [x] Do not make tests or default commands call real providers.
- [x] Keep machine-readable output free of decorative UI.
- [x] Keep secret redaction in all human-facing traces.
- [x] Keep current workspace sandbox behavior unless explicitly changed.

## Verification

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
PATH=.tools/bun/bin:$PATH bun run src/cli/index.ts --help
PATH=.tools/bun/bin:$PATH bun run src/cli/index.ts doctor
PATH=.tools/bun/bin:$PATH bun run src/cli/index.ts tool list
PATH=.tools/bun/bin:$PATH bun run src/cli/index.ts skill list
PATH=.tools/bun/bin:$PATH bun run src/cli/index.ts mcp list
```

Optional live checks:

```bash
MINICODE_API_KEY=... PATH=.tools/bun/bin:$PATH bun run src/cli/index.ts -p "hello"
MINICODE_API_KEY=... PATH=.tools/bun/bin:$PATH bun run src/cli/index.ts chat
```

Latest verification:

- `PATH=.tools/bun/bin:$PATH bun run typecheck`
- `PATH=.tools/bun/bin:$PATH bun test` (112 pass, 0 fail)
- Real provider `-p` smoke using `docs/keys/api_key.jsonl` key injected through `MINICODE_API_KEY`
- Real provider `--output-format stream-json` smoke using the same env injection
- Real provider `--permission-mode plan --output-format stream-json` smoke using the same env injection, confirmed permission denial result and exit code `3`
- Real provider `chat --no-color` startup smoke using the same env injection, confirmed banner and Ctrl-C first-warning / second-exit behavior with process SIGINT
- Real provider `chat --no-color` piped `/help` smoke using the same env injection, confirmed `/paste` appears in slash command help.
- Real provider Markdown text-output smoke using the same env injection
- Real provider parser smoke after adding support for Markdown-bold `**FINAL:**`
- Real provider parser smoke for a continuation response ending in `FINAL:`, confirmed `stream-json` final `result` does not leak the completion marker.
- Real CodeBuddy `--help`, `-p --output-format text`, `-p --output-format stream-json`, and interactive startup trust-panel probes with `bash -ic`
- Fresh local CodeBuddy probe on 2026-06-06:
  - `bash -ic 'cd /home/gujing/code/minicode && codebuddy --version'` -> `2.103.1`
  - `codebuddy -p --output-format text ...` returns only concise final Markdown text, without a startup panel.
  - `codebuddy -p --output-format stream-json ...` begins with `system/init`, includes session/cwd/tools/model/permission/slash command metadata, and ends with a `result` event containing duration, turns, usage, and permission denials.
- Local smoke for `--help`, `doctor`, `tool list`, `skill list`, and `mcp list`
- Narrow regression checks after the latest MCP/stream-json changes:
  - `PATH=.tools/bun/bin:$PATH bun test test/cli/mcp.test.ts test/cli/run-process.test.ts`

Latest minicode implementation notes:

- Core-first decision: Web UI, daemon/background sessions, worktree mode, sub-agent/team mode, and a full TUI framework remain explicitly deferred. They are useful CodeBuddy-style capabilities, but adding them now would distract from minicode's compact agent core.
- `--permission-mode default|acceptEdits|bypassPermissions|plan` is now supported for `run`, `-p`, and `chat`. `--yes` remains a compatibility alias for `bypassPermissions`.
- `acceptEdits` auto-approves `write`, `edit`, and `patch` ask rules while preserving normal shell rules. `plan` allows read/planning tools and denies write/execute tools.
- Run exit codes now distinguish clean success (`0`), pre-run CLI/config/provider setup errors (`1`), provider/runtime run errors (`2`), permission denials (`3`), and max-step stops (`4`).
- `doctor --json` is available for scripts.
- `minicode --help` is grouped by Agent commands, Inspect, Config, Skills, MCP, common options, and examples.
- Chat slash commands now include `/clear`; `/mcp` and `/skills` render table-style output.
- Chat now supports `/paste` multiline input, blank input skip, prompt history where readline is available, and compact user-message echo before each agent run.
- Chat startup now shows a compact `mini code` identity block, shortcut hint, Ctrl-D guidance, and recent activity. Ctrl-C once warns or cancels an active run; Ctrl-C again exits from the prompt.
- Interactive permission prompts show tool, risk, and rule reason, and now support allow once, deny once, or allow for the current chat session.
- Text output has a lightweight Markdown renderer for headings, bullets, blockquotes, code fences, and simple tables without pulling in a heavy TUI dependency.
- Text-mode output has regression coverage to keep reasoning and `FINAL:` protocol markers out of the default user view.
- `stream-json` now emits complete assistant text messages by default and does not duplicate partial text deltas before the final message. This matches CodeBuddy's default event shape more closely; a future `--include-partial-messages` flag could expose raw deltas if needed.
- `mcp list` now includes `transport` in table and JSON status output.
- `skill list` and local `skill search` now show `skill`, `description`, and `source` columns.
- `doctor` now includes a Bun row and keeps provider secrets redacted.

Official docs and user-verifiable links:

- CodeBuddy CLI overview: `https://www.codebuddy.cn/docs/cli/`
- CodeBuddy CLI reference: `https://www.codebuddy.cn/docs/cli/cli-reference`
- CodeBuddy interactive mode: `https://www.codebuddy.ai/docs/cli/interactive-mode`
- CodeBuddy headless mode: `https://www.codebuddy.ai/docs/cli/headless`
- CodeBuddy Web UI: `https://www.codebuddy.cn/docs/cli/web-ui`
- Tencent CloudBase wrapper setup for CodeBuddy Code: `https://docs.cloudbase.net/cli-v1/ai/codebuddy`

## Notes From Local CodeBuddy Probe

Environment finding:

- A normal non-interactive shell resolved `codebuddy` to the Windows npm shim at `/mnt/c/Users/20733/AppData/Roaming/npm/codebuddy` and `node` to `/usr/bin/node v18.19.1`, which fails CodeBuddy's Node requirement.
- An interactive shell (`bash -ic`) loads nvm and resolves `codebuddy` to `/home/gujing/.nvm/versions/node/v24.16.0/bin/codebuddy`, which works.
- For future probes from automation, run CodeBuddy with `bash -ic 'cd <dir> && codebuddy ...'`.

- Installed package: `@tencent-ai/codebuddy-code@2.103.1`.
- CLI aliases: `codebuddy` and `cbc`.
- Real `-p` runs work through the nvm-backed Linux install.
- Useful observed command flags include `-p/--print`, `--output-format`, `--input-format`, `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--mcp-config`, `--continue`, `--resume`, `--worktree`, `--model`, `--serve`, `--acp`, `--sandbox`, `--system-prompt`, `--agent`, `--agents`, and `--settings`.

Observed `-p --output-format text` behavior:

- Prints only the final assistant answer.
- No startup panel, no tool event log, no JSON envelope.
- Good model for minicode's `-p` / script-friendly text mode.

Observed `-p --output-format json` behavior:

- Returns a JSON array of events.
- Includes user message context, file history snapshot, reasoning event, assistant message, and final result.
- Reasoning is present in JSON but not in text mode.
- Final result includes `session_id`, duration, number of turns, token usage, and permission denials.

Observed `-p --output-format stream-json` behavior:

- Emits newline-delimited JSON events in realtime.
- First event is `system/init` with session id, cwd, available tools, MCP servers, model, permission mode, slash commands, and output style.
- Status updates are separate `system/status` events.
- Tool calls are assistant messages containing `tool_use`.
- Tool results are user messages containing `tool_result`.
- Final event is `result` with success/error status, final text, session id, duration, API duration, turn count, usage, and permission denials.

Observed tool-call probe:

- Prompt: create `hello.txt`, read it, and summarize.
- CodeBuddy emitted a `Write` tool_use, a file-history snapshot update, a `tool_result`, then a `Read` tool_use and `tool_result`, then final assistant text.
- With `-y`, `permissionMode` in init became `bypassPermissions`.
- Tool paths were absolute paths rooted at the working directory.

Observed interactive TUI behavior:

- First launch showed a trust prompt before the normal chat UI:
  - "Do you trust the files in this folder?"
  - Options included trusting the current folder, parent folder, current folder plus subdirectories, or exiting.
  - It explicitly warned that CodeBuddy may read, write, or execute files in the directory.
- Startup panel shows product/version, large block logo, tips, recent activity, local Web UI URL, model/billing, and cwd.
- Input area is separated by horizontal rules and uses `>` as the prompt marker.
- Footer shows `? for shortcuts`; right side can show `Thinking on (tab to toggle)`.
- First Ctrl-C shows `Press Ctrl + C again to exit` rather than exiting immediately.
- PTY automation captured the startup panel reliably; a submitted prompt did not flush the expected answer in this harness, so interactive answer rendering still needs either manual observation or a better TUI capture method.

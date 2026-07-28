# pixiu

Pixiu is a local-first, self-evolving CLI agent for your terminal: it helps you do real work, learns from each task, and distills repeated experience into reusable Skills.

The core stays focused on dependable agent primitives: LLM streaming, local file tools, shell execution, permissions, session workspaces, evidence, Skills, MCP, and a polished interactive CLI. Domain-specific workflows can start as temporary scripts, then graduate into local Skills or MCP servers when they prove useful.

## Latest Update

The local browser UI is now a responsive agent workbench:

- OpenCode-inspired navigation, conversation, and resizable Inspector regions with restrained visual tokens.
- Markdown and GFM rendering, highlighted code with copy controls, safe links, tool status, attachments, and artifacts grouped by assistant turn.
- Project file tree, Git changed-file summary, file preview, and diff views in the Inspector.
- Revision-safe file and hunk review with Apply, Discard, Undo, Stage, and Commit actions.
- Turn-bound Tests, Typecheck, Build, and confirmed custom validations with a direct repair action on failures.
- Whole-file and line-range prompt references, cross-model retry, stream reconnection, and pre-turn file checkpoints.
- Provider and model selection, including the validated SiliconFlow models `deepseek-ai/DeepSeek-V3.2` and `Pro/moonshotai/Kimi-K2.6`.
- Mobile and tablet drawers with keyboard focus management, Escape handling, and trigger-focus restoration.
- Hardened session switching, uploads, cancellation, permission recovery, and interrupted event-stream behavior.

## Highlights

- Interactive terminal chat with a startup panel, recent activity, live run status, permission prompts, and slash commands.
- Responsive local browser workbench with project navigation, rich chat rendering, workspace inspection, and Git diffs.
- OpenAI-compatible provider support with quick plug-and-play API configuration.
- Per-session workspaces so agent artifacts do not clutter your project root.
- Built-in tools for reading, searching, shell commands, writing, editing, patching, todos, and Skills.
- Reusable local Skills so repeated workflows can become durable team or personal knowledge.
- Permission modes for safe review, accepted edits, plan-only runs, and explicit bypass.
- Local Skills and SkillHub install/search flows.
- MCP server lifecycle commands for stdio and HTTP servers.
- Human output, JSON output, and stream-json output for scripts and integrations.

## Requirements

- Bun 1.3+
- An OpenAI-compatible API provider

This repository is currently Bun-first.

## Quick Start

```bash
git clone <your-repo-url>
cd pixiu
bun install
bun run typecheck
bun test
```

Run the CLI from source:

```bash
bun run src/cli/index.ts --help
bun run src/cli/index.ts
```

Link the local command during development:

```bash
bun link
pixiu --help
```

After linking or installing the command, use:

```bash
cd /path/to/your/project
pixiu init
pixiu ui
```

`pixiu init` creates a minimal `pixiu.jsonc` only when neither `pixiu.jsonc` nor the legacy `minicode.jsonc` exists. It detects available `test`, `typecheck`, and `build` commands from common project manifests. Re-running it does not overwrite existing configuration.

## Configure A Provider

The easiest path is to enter the interactive CLI and configure the provider there:

```bash
pixiu
```

Then run:

```text
/config setup
```

You can also configure in one line:

```bash
pixiu config use siliconflow <api-key> Pro/moonshotai/Kimi-K2.6
```

Or keep the key in your shell instead of writing it into `pixiu.jsonc`:

```bash
export PIXIU_API_KEY="<api-key>"
pixiu config use-env siliconflow PIXIU_API_KEY Pro/moonshotai/Kimi-K2.6
```

For a project-local secret file, keep the key out of process arguments and Git:

```bash
chmod 600 pwd
export SILICONFLOW_API_KEY="$(<pwd)"
pixiu config use-env siliconflow SILICONFLOW_API_KEY Pro/moonshotai/Kimi-K2.6
```

The repository ignores the root-level `pwd` file. Do not print, copy into tracked config, or commit the key.

Supported endpoint aliases:

- `siliconflow` / `sf` -> `https://api.siliconflow.cn/v1`
- `openai` -> `https://api.openai.com/v1`
- `deepseek` -> `https://api.deepseek.com/v1`

You can always pass a full base URL instead of an alias:

```bash
pixiu config use https://api.example.com/v1 <api-key> provider/model
```

Provider config is written to project-local `pixiu.jsonc`. During migration, Pixiu can still read a legacy `minicode.jsonc` when `pixiu.jsonc` is absent. Secret values are redacted from `config get`, `config list`, and `config show` output.

## Usage

### Local Terminal

From a source checkout:

```bash
bun run src/cli/index.ts
bun run src/cli/index.ts run "summarize this repository"
```

After `bun link` or package installation, the equivalent commands are:

```bash
pixiu
pixiu chat
pixiu run "summarize this repository"
pixiu -p "explain src/cli/index.ts"
```

Interactive chat supports slash commands, live tool activity, permission prompts, session resume, and multiline input. Use `Ctrl-C` to cancel an active run and `/exit` or end-of-input to leave the chat.

Resume work from the terminal:

```bash
pixiu -c "continue"
pixiu run --session <session-id> "continue from here"
pixiu session list
```

### Local Browser UI

Run the browser workbench from the project directory:

```bash
# Installed or linked command; opens the browser automatically.
pixiu ui

# Source checkout; print the URL without opening a browser.
bun run src/cli/index.ts ui --port 2208 --no-open
```

The server binds to `127.0.0.1:2208` by default. Open the exact URL printed by the command, including its `?token=...` query. The random token protects the local API for the lifetime of that server process; do not remove or share it. Stop the server with `Ctrl-C`, or choose another port with `--port` if `2208` is occupied.

On first launch, choose the project workspace, configure the Provider, and pass the connection test. The setup dialog stays open until the connection succeeds. Later, use **Settings** to change or retest the Provider.

The browser UI and terminal CLI use the same project configuration and session store. New browser sessions receive an isolated persistent `baseline` and `work` copy under the user's XDG state directory. Agent tools run in `work`; the real project changes only when you select reviewed files or hunks and choose **Apply**. `.git`, `.pixiu`, `node_modules`, and `pwd` are excluded from the copied workspace.

The normal browser workflow is:

1. Ask Pixiu to make a change.
2. Open **Inspector -> Changes** and select complete files or individual diff hunks.
3. Choose **Apply** or **Discard**. Use **Undo apply** to restore the real project after the latest apply.
4. Run **Tests**, **Typecheck**, **Build**, or a confirmed custom validation. Results stay attached to the assistant turn; failed checks expose **Ask Pixiu to fix**.
5. Stage reviewed files or individual hunks, enter a commit message, and commit. Pixiu refuses to include already-staged files that do not belong to the current session.

In **Files**, choose **Add to prompt** for a whole file, or enter Start/End lines to add a range such as `@src/ui/client/App.tsx` or `@src/ui/client/styles.css:110-130`. References appear as removable composer labels and only the selected line range is sent to the model.

Each assistant turn records its model, duration, input/output tokens, failure reason, retry count, and pre-turn checkpoint. Use **Retry**, **Retry with another model**, or **Restore files before turn** when a run fails or takes the wrong direction. Interrupted event streams reconnect from the last received event without duplicating prior events.

For a headed browser task that requires login, captcha, payment, or another manual action, Pixiu finishes the current run with `user_action_required` and keeps the named browser session open. Complete the requested action in the browser, then send Pixiu a new message such as `done`. `browser-use state` is a point-in-time snapshot rather than a background page watcher, so that follow-up message is what tells Pixiu to inspect the page again and continue.

A browser opened by `browser-use` is owned by its background session. Closing the Chrome window directly may leave that session running or allow it to recreate an empty window. After the browser task is complete, close the session by using the session name shown in Activity:

```bash
browser-use --session <session-name> close

# If browser-use is installed in the pixiu-tools Conda environment:
conda run -n pixiu-tools browser-use --session <session-name> close
```

Do not close the session while Pixiu is waiting for a manual action, because the same session contains the current page and login state.

Pixiu is not a hosted web service. Keep the default loopback binding for normal use. For remote access, prefer an SSH tunnel to `127.0.0.1:2208`; `--host 0.0.0.0` exposes the token-protected HTTP service without TLS and should not be published directly to the internet.

### Scripted Runs

Run a single task without entering interactive chat:

```bash
pixiu run "summarize this repository"
pixiu -p "explain src/cli/index.ts"
```

Useful output modes:

```bash
pixiu run --output-format text "hello"
pixiu run --output-format json "hello"
pixiu run --output-format stream-json "hello"
```

Useful chat slash commands:

```text
/help
/config
/config setup
/clear
/compact
/paste
/tools
/session
/model
/mcp
/skills
/doctor
/exit
```

## Permissions

pixiu has permission modes for different levels of autonomy:

```bash
pixiu run --permission-mode default "inspect the repo"
pixiu run --permission-mode acceptEdits "update the docs"
pixiu run --permission-mode plan "plan the refactor"
pixiu run --permission-mode bypassPermissions "do the task"
```

Modes:

- `default`: use configured permission rules.
- `acceptEdits`: auto-approve edit/write/patch ask rules, while keeping shell governed by normal rules.
- `plan`: allow read/planning tools and deny write/execute tools.
- `bypassPermissions`: allow all tool calls. `--yes` is an alias.

Interactive chat prompts before risky tools when the config says `ask`.

## Workspaces And Sessions

By default, each run gets a workspace under:

```text
workspace/<session-id>/
```

File tools and shell commands run in that session workspace. This keeps generated files and temporary scripts out of your project root unless you intentionally write there.

Sessions are stored under:

```text
.pixiu/state/sessions/
```

## Configuration

Create or edit `pixiu.jsonc` in your project root. A full example is available in [`pixiu.example.jsonc`](./pixiu.example.jsonc).

Initialize a project automatically:

```bash
pixiu init
```

`pixiu init` creates a minimal `pixiu.jsonc` and detects common `test`, `typecheck`, and `build` commands from project manifests. It prefers explicit package scripts and uses the package manager declared by `packageManager` or the local lockfile; Make, Cargo, Go, Deno, and common Python metadata are also recognized. The detected commands are stored under `project.commands` for project tooling to inspect.

The command is idempotent. If `pixiu.jsonc` or the legacy `minicode.jsonc` already exists, Pixiu leaves it byte-for-byte unchanged.

Common commands:

```bash
pixiu config show
pixiu config validate
pixiu config list
pixiu config get model
pixiu config set ui.accentColor "#3B8EEA"
pixiu config set sandbox.shellTimeoutMs 30000
```

`config set` rewrites `pixiu.jsonc` as formatted JSON, so keep comment-heavy config templates under version control.

## Skills

Local Skills are discovered from:

- `.pixiu/skills/**/SKILL.md` (highest default priority)
- `.opencode/skills/**/SKILL.md`
- `~/.claude/skills/**/SKILL.md`
- `~/.agents/skills/**/SKILL.md`

Commands:

```bash
pixiu skill init weather --description "Weather lookup workflow"
pixiu skill list
pixiu skill show <name>
pixiu skill search "react"
pixiu skill search --remote "react"
pixiu skill path add ./my-skills
pixiu skill doctor
pixiu skill install <remote-id> --yes
```

Remote SkillHub search/install requires `SKILLHUB_API_KEY`.

If two installed Skills use the same `name`, the first discovered source wins and later duplicates are reported by `pixiu skill doctor`. The configured `skills.paths` order controls root precedence; within one root, `SKILL.md` paths are sorted for deterministic loading.

Each Skill only needs `name` and `description`, but optional frontmatter such as `triggers`, `when_to_use`, `when_not_to_use`, `required_tools`, `risk`, `version`, `dependencies`, `inputs`, `outputs`, and `quality_checks` can improve local search and review output. Reference files are listed conservatively: generated folders, dependency folders, binary assets, and oversized files are skipped.

## MCP

Use MCP for durable external tools that should not live in pixiu core.

```bash
pixiu mcp add stdio local-tools -- node ./mcp-server.js
pixiu mcp add http remote-tools http://127.0.0.1:9876/mcp
pixiu mcp list
pixiu mcp test <name>
pixiu mcp doctor
pixiu mcp disable <name>
pixiu mcp enable <name>
pixiu mcp remove <name>
```

`mcp list` reports configured servers as `connected`, `failed`, or `disabled`.

## Development

```bash
bun install
bun run ui:build
bun run typecheck
bun test
```

Optional live-provider smoke:

```bash
bun run smoke:llm
```

## Design Notes

Pixiu does not try to hard-code every vertical capability into the core. For live data or one-off automation, the agent should use web tools, shell commands, temporary scripts, Skills, or MCP tools. Durable workflows can graduate into Skills or MCP servers.

This keeps Pixiu local-first, understandable, and able to evolve through reusable knowledge instead of a bloated built-in tool list.

## License

MIT

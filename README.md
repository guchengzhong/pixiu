# pixiu

Pixiu is a local-first, self-evolving CLI agent for your terminal: it helps you do real work, learns from each task, and distills repeated experience into reusable Skills.

The core stays focused on dependable agent primitives: LLM streaming, local file tools, shell execution, permissions, session workspaces, evidence, Skills, MCP, and a polished interactive CLI. Domain-specific workflows can start as temporary scripts, then graduate into local Skills or MCP servers when they prove useful.

## Latest Update

This update renames the project from `minicode` to `pixiu` and clarifies the product direction:

- New command and package identity: `pixiu`.
- New project config and state paths: `pixiu.jsonc`, `pixiu.example.jsonc`, and `.pixiu/**`.
- Legacy migration support: Pixiu still reads `minicode.jsonc` when `pixiu.jsonc` is absent.
- Refreshed terminal startup panel with a compact pixel mascot and recent activity.
- Clearer local-first positioning: use temporary scripts for one-off work, then turn repeated workflows into reusable Skills.
- Better long-session controls: `/clear` hides the visible transcript, while `/compact` summarizes older context without deleting session history.
- Research/live-data path: `web_search` and `web_fetch` are available as permissioned tools, with source links expected in generated artifacts.

## Highlights

- Interactive terminal chat with a startup panel, recent activity, live run status, permission prompts, and slash commands.
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
pixiu
```

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
pixiu config use siliconflow <api-key> deepseek-ai/DeepSeek-V3.2
```

Or keep the key in your shell instead of writing it into `pixiu.jsonc`:

```bash
export PIXIU_API_KEY="<api-key>"
pixiu config use-env siliconflow PIXIU_API_KEY deepseek-ai/DeepSeek-V3.2
```

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

Start interactive chat:

```bash
pixiu
pixiu chat
```

Start the local browser UI:

```bash
pixiu ui
pixiu ui --port 2208 --no-open
```

The UI listens on `127.0.0.1` by default and prints a one-time local token in the URL. It provides a ChatGPT-style workspace for provider setup, new and resumed chats, file uploads, browser permission prompts, run trace, workspace files, evidence, and status diagnostics. Provider keys can be saved to project-local `pixiu.jsonc` or referenced through an environment variable; config and run outputs redact common secret shapes.

Run a single task:

```bash
pixiu run "summarize this repository"
pixiu -p "explain src/cli/index.ts"
```

Resume work:

```bash
pixiu -c "continue"
pixiu run --session <session-id> "continue from here"
pixiu session list
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

- `.pixiu/skills/**/SKILL.md`
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

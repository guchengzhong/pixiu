# pixiu Usage

## Install

This repo is Bun-first.

```bash
PATH=.tools/bun/bin:$PATH bun install
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
```

## Provider Config

Create `pixiu.jsonc` in the project root:

```jsonc
{
  "model": "openai-compatible/model-name",
  "providers": {
    "openai-compatible": {
      "type": "openai-compatible",
      "baseURL": "https://api.example.com/v1",
      "apiKeyEnv": "PIXIU_API_KEY",
      "model": "provider/model"
    }
  }
}
```

Then run with a real provider key:

```bash
PIXIU_API_KEY=... pixiu run "hello"
```

`run` and `chat` require a real provider API key. pixiu does not provide an offline heuristic agent mode.

Real provider smoke is explicit opt-in:

```bash
PATH=.tools/bun/bin:$PATH bun run smoke:llm
```

## Run

```bash
pixiu
pixiu run "hello"
pixiu -p "hello"
pixiu run --json "hello"
pixiu run --output-format json "hello"
pixiu run --output-format stream-json "hello"
pixiu run -c "continue the latest session"
pixiu run --session <session-id> "continue"
pixiu run --permission-mode acceptEdits "update docs"
pixiu chat
pixiu session list
pixiu session resume
pixiu session show <session-id>
pixiu config list
pixiu config get model
pixiu config set sandbox.shellTimeoutMs 30000
```

`pixiu` with no arguments starts the interactive chat UI. Use this when you want the CodeBuddy-style terminal experience with a startup panel, recent activity, shortcut hints, and an input prompt.

Use `pixiu ui` when you want the browser workspace:

```bash
pixiu ui
pixiu ui --port 2208 --no-open
```

The browser UI is local-first: it binds to `127.0.0.1` by default and requires the token printed in the URL for API calls. It lets you configure and test an OpenAI-compatible provider, create or resume sessions, upload files into the session workspace, approve or deny permission prompts, cancel runs, preview text artifacts, copy workspace-relative paths, and inspect trace/evidence/status panels.

Provider setup in the browser supports endpoint aliases (`siliconflow`, `openai`, `deepseek`), custom base URLs, plaintext API keys, or API key environment variable names. Plaintext keys are written to project-local `pixiu.jsonc`; use the env-var mode if you do not want secrets in the project config.

Default `run` output is formatted for people: it streams concise traces for tool calls and then prints the final answer. For example, shell calls show the command, exit code, elapsed time, and output size; failed tools also show a short redacted preview.

`-p` / `--print` is a shortcut for non-interactive text output. It is meant for pipes and scripts, so it does not show the interactive startup panel or input box. It prints only the human-facing result plus any compact tool trace needed to explain work.

Output formats:

- `--output-format text`: default human output.
- `--json`: compatibility JSONL stream of pixiu agent events.
- `--output-format json`: pretty JSON array ending with a `result` summary.
- `--output-format stream-json`: realtime newline-delimited JSON with a CodeBuddy-style `system/init` event, assistant/tool events, and a final `result` event. By default it emits complete assistant messages rather than duplicate partial text deltas.

Color is only enabled for TTY output. Use `--no-color` or `NO_COLOR=1` to disable ANSI styling. Use `--verbose` to include successful tool output previews in the human trace.

Text output applies a lightweight Markdown pass for headings, bullets, blockquotes, code fences, and simple tables. It is intentionally small and keeps JSON modes untouched.

Run exit codes:

- `0`: completed without runner errors or permission denials.
- `1`: CLI usage, configuration, provider setup, or pre-run failure.
- `2`: provider/runtime error during the agent run.
- `3`: one or more tool calls were denied by permissions.
- `4`: the agent stopped after `maxSteps`.

Permission modes:

- `--permission-mode default`: use configured rules; `ask` rules are denied in non-interactive `run` and prompt in interactive `chat`.
- `--permission-mode acceptEdits`: auto-approve `write`, `edit`, and `patch` ask rules while keeping shell and other risky tools governed by the normal rules.
- `--permission-mode bypassPermissions`: allow all tool calls, including rules that would normally deny. `--yes` is a compatibility alias for this mode.
- `--permission-mode plan`: allow read/planning tools only and deny write/execute tools.

Use `--yes` only when you want non-interactive approval for high-risk tools such as `shell`, `write`, `edit`, and `patch`.

`doctor` now reports a compact table for config, provider key presence, workspace/session state, skills, and MCP. Use `doctor --json` for scripts. Provider keys and config secrets are redacted in config output.

`config set` rewrites the project `pixiu.jsonc` as formatted JSON. It does not preserve JSONC comments yet, so keep comment-heavy templates under version control before using automated config writes.

By default, each new run uses a per-session workspace directory:

```text
workspace/<session-id>/
```

File tools and shell commands run inside that directory, so task artifacts do not pollute the pixiu repo root. When you continue with `--session <session-id>`, pixiu reuses the original session workspace. Set `sandbox.mode` to `local` if you intentionally want the older behavior where tools run directly in the project root.

Use `-c` / `--continue` to resume the most recently updated session. `pixiu session resume` prints that latest session id for scripts.

In `pixiu chat`, use `/help` for slash commands and `/clear` to hide the visible transcript while keeping the active session and context. Use `/paste` for multiline input, finish with a single `.`, and cancel the buffer with `/cancel` or Ctrl-C. Blank input is ignored instead of exiting. Ctrl-D exits cleanly. Ctrl-C once warns at the prompt or cancels an active run; Ctrl-C again exits.

When `chat` asks for a risky tool permission, answer `y` to allow once, `a` to allow matching requests for the current chat session, or press Enter/`n` to deny once.

Agent runs use an internal completion protocol: the model should mark a true final answer with `FINAL:`. If it only says what it plans to do, pixiu treats that text as a draft and asks it to continue once; if the model still does not mark a final answer, pixiu returns the next text response as a fallback so the run does not spin forever.

## Core Tools

The default agent is intentionally small. Built-ins include:

- `read`, `grep`, `glob`
- `shell`
- `write`, `edit`, `patch`
- `todo`
- `skill`

The important product rule is: do not hard-code every domain as a permanent tool. For live data or one-off automation, the agent should inspect available tools/skills first. If no reliable tool exists, it should create a short temporary script under `.pixiu/tmp/` or run a shell command, parse the result, and write the requested artifact.

Example: ask pixiu to query Wuhan weather and save a Markdown report without relying on a built-in weather tool:

```bash
PIXIU_API_KEY=... pixiu run --yes \
  "请在线查询武汉 2026-06-05 的天气，并整理到 docs/wuhan-weather.md。
   如果没有内置天气工具，请用 shell 创建 .pixiu/tmp/wuhan-weather.ts 临时脚本，
   调用公开天气 API 或网页数据，解析结构化结果，然后用 write 写入 Markdown。
   文件里包含地点、日期、天气概况、最高/最低温、降水概率、风力、数据来源 URL 和访问时间。"
```

Add a durable tool only when the workflow is common enough to deserve a stable interface. Otherwise prefer temporary scripts, local skills, or MCP servers. Remote SkillHub search/install is available through CLI commands, but it is not exposed to the default agent unless you opt in from config.

## Skills

Local skills are discovered from:

- `.pixiu/skills/**/SKILL.md`
- `.opencode/skills/**/SKILL.md`
- `~/.claude/skills/**/SKILL.md`
- `~/.agents/skills/**/SKILL.md`

Commands:

```bash
pixiu skill init weather --description "Weather lookup workflow"
pixiu skill list
pixiu skill list --json
pixiu skill show <name>
pixiu skill search "react"
pixiu skill search --remote "react"
pixiu skill path list
pixiu skill path add ./my-skills
pixiu skill path remove ./my-skills
pixiu skill doctor
pixiu skill install <remote-id> --yes
```

`skill init` creates a local `SKILL.md` under the configured install directory, which defaults to `.pixiu/skills`. Use `skill path add/remove` to configure additional project-local skill roots in `pixiu.jsonc`.

SkillHub Skills API requires a SkillHub API key:

```bash
SKILLHUB_API_KEY=... pixiu skill search --remote "react"
```

Remote installs are review-first. Running `pixiu skill install <remote-id>` prints the target directory and planned file list, then exits until you re-run with `--yes`. Confirmed installs write `.source.json` beside `SKILL.md`; it records the remote id/source/version, install time, target directory, and SHA-256 digests for installed files.

## MCP

```bash
pixiu mcp add stdio local-tools -- node ./mcp-server.js
pixiu mcp add stdio local-tools --timeout-ms 1000 --env FOO=bar -- node ./mcp-server.js
pixiu mcp add http remote-tools http://127.0.0.1:9876/mcp
pixiu mcp add http remote-tools https://example.com/mcp --header Authorization="Bearer token"
pixiu mcp list
pixiu mcp list --json
pixiu mcp test <name>
pixiu mcp test <name> --json
pixiu mcp doctor
pixiu mcp doctor --json
pixiu mcp disable <name>
pixiu mcp enable <name>
pixiu mcp remove <name>
```

Use MCP for durable external capabilities that should not live in the pixiu core. `mcp list` reports each configured server as `connected`, `failed`, or `disabled` with transport, tool count, and a short error summary.

`mcp add` writes to the project `pixiu.jsonc`. Existing server names are protected by default; re-run with `--yes` when you intentionally want to overwrite a server config. `mcp doctor` performs the same status inspection as `mcp list`, then returns a non-zero exit code when any configured server fails.

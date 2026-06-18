# 260620 Agent Reach Skill Integration TODO

## Goal

Integrate Agent Reach into Pixiu as an optional local Skill, not as a Pixiu core dependency.

Agent Reach should give Pixiu a stronger internet/platform research path for YouTube, Twitter/X, Reddit, XiaoHongShu, Bilibili, GitHub, RSS, V2EX, LinkedIn, Xueqiu, and Exa-backed search while preserving Pixiu's existing lightweight built-in web tools and local-first runtime model.

The desired result:

- Pixiu can discover an `agent-reach` Skill from the normal local Skill paths.
- The default agent can load the Skill when platform-specific internet access is needed.
- Agent Reach installation, doctor, update, cookies, and optional channels remain explicit and permissioned shell operations.
- Pixiu core does not vendor Python code, upstream CLIs, browser-login tooling, or Agent Reach as a required runtime dependency.

## Current State

- Pixiu already discovers local Skills from `.pixiu/skills`, `.opencode/skills`, `~/.claude/skills`, and `~/.agents/skills`.
- Pixiu already injects compact installed Skill summaries into the system prompt and exposes `skill_search` / `skill` tools.
- Pixiu already has generic `web_search` and `web_fetch` tools for simple current lookup and URL reading.
- Agent Reach is cloned locally at `/home/gujing/code/Agent-Reach`.
- Agent Reach ships a `agent_reach/skill/SKILL.md` plus reference files.
- Agent Reach's upstream Skill is broad and assertive: it says to use Agent Reach for almost any internet lookup or URL.
- That broad behavior is good for standalone agent environments, but too aggressive for Pixiu because it can overshadow Pixiu's built-in `web_search` / `web_fetch` fallback path.

## Design Principles

### 1. Skill-first, core-stable

The first integration should be a project-local Pixiu Skill:

```text
.pixiu/skills/agent-reach/SKILL.md
.pixiu/skills/agent-reach/references/*.md
```

Do not change:

- `AgentRunner`
- `ToolRegistry`
- built-in web tools
- sandbox/path guard behavior
- MCP loading behavior
- default provider setup

### 2. Pixiu keeps its lightweight web fallback

Agent Reach should not replace Pixiu's generic web tools.

Expected routing:

```text
simple URL read            -> web_fetch first
lightweight web search     -> web_search first
platform-specific research -> agent-reach Skill + shell/upstream CLIs
multi-platform research    -> agent-reach Skill + references
```

Examples for Agent Reach:

- Twitter/X search or tweet reading
- Reddit search/post/comment reading
- XiaoHongShu search/note/comment reading
- YouTube subtitles or video metadata
- Bilibili search/details/subtitles
- GitHub code/repo/issue/PR research through `gh`
- RSS feed parsing
- Exa semantic web search through `mcporter`
- V2EX topic reading
- LinkedIn job/profile/company lookup
- Xueqiu stock/community lookup

### 3. Installation remains explicit and permissioned

Do not silently run:

```bash
agent-reach install --env=auto
```

Agent Reach installation can install or configure external tools such as Python packages, Node packages, `mcporter`, `gh`, `yt-dlp`, OpenCLI, cookies, browser-backed credentials, and `~/.agent-reach` files.

Those actions must happen through Pixiu's normal `shell` permission path, with the user able to review commands.

### 4. No workspace pollution

Agent Reach's own guidance says not to clone repos or create persistent tool files inside the agent workspace.

Pixiu's adapter Skill should preserve that:

- persistent Agent Reach config: `~/.agent-reach/`
- temporary command output: `/tmp/` or the session workspace only when the user asks for an artifact
- Pixiu Skill copy: `.pixiu/skills/agent-reach/`
- no upstream tool repos under Pixiu's project root

### 5. Prefer an adapted Skill over raw upstream SKILL.md

The upstream Agent Reach `SKILL.md` should be used as source material, but Pixiu should install an adapted version with Pixiu-specific boundaries.

The adapted Skill should say:

- Use Pixiu `web_search` / `web_fetch` for simple generic lookup.
- Use Agent Reach for platform-specific or multi-backend internet access.
- Run `agent-reach doctor --json` before platform-specific work when Agent Reach is installed.
- If Agent Reach is missing, explain the install options before running them.
- Use safe/dry-run modes when appropriate.
- Do not perform write actions on social platforms unless the user explicitly asks.

## Slice 1: Create Pixiu Adapter Skill

- [x] Create `.pixiu/skills/agent-reach/SKILL.md`.
  - [x] Use `name: agent-reach`.
  - [x] Write a Pixiu-specific `description` that does not claim all URLs/searches.
  - [x] Include triggers for platform names and multi-platform research.
  - [x] Include `required_tools: shell, skill`.
  - [x] Include `risk: medium` or `risk: high` depending on final wording.
- [x] Copy relevant Agent Reach reference files into `.pixiu/skills/agent-reach/references/`.
  - [x] `search.md`
  - [x] `social.md`
  - [x] `video.md`
  - [x] `web.md`
  - [x] `dev.md`
  - [x] `career.md`
- [x] Add a small `references/pixiu-routing.md`.
  - [x] Explain when to use Pixiu built-in web tools.
  - [x] Explain when to use Agent Reach.
  - [x] Explain install/doctor/update command policy.
  - [x] Explain credential and cookie handling boundaries.
- [x] Keep the Skill concise enough that loading it does not flood context.
  - [x] Put long command matrices in reference files.
  - [x] Use the main `SKILL.md` as routing guidance.

## Slice 2: Validate Pixiu Skill Compatibility

- [x] Run local Skill discovery.

```bash
pixiu skill list
pixiu skill show agent-reach
pixiu skill doctor
```

- [x] Confirm `agent-reach` appears from `.pixiu/skills/agent-reach/SKILL.md`.
- [x] Confirm reference files are listed and readable through `pixiu skill show`.
- [x] Confirm no duplicate `agent-reach` Skill from `~/.agents/skills` or `~/.claude/skills` unexpectedly wins.
- [x] If duplicates exist, decide precedence intentionally.
  - [x] Prefer project-local `.pixiu/skills/agent-reach`.
  - [x] Document that project-local copy is the Pixiu adapter.
  - [x] Leave user-global upstream copies alone.

## Slice 3: Agent Reach Runtime Availability Checks

- [x] Decide whether the Skill should instruct the agent to run `agent-reach doctor --json` only when needed or at the beginning of every platform task.
  - [x] Prefer only when platform-specific work starts.
  - [x] Avoid adding latency to simple `web_fetch` / `web_search` tasks.
- [x] Define missing-install behavior.
  - [x] If `agent-reach` command is missing, explain install choices.
  - [x] Prefer safe preview first:

```bash
agent-reach install --env=auto --safe
agent-reach install --env=auto --dry-run
```

  - [x] Run full install only after user intent is clear:

```bash
agent-reach install --env=auto
```

- [x] Define optional channel behavior.
  - [x] Do not install `--channels=all` by default.
  - [x] Ask/confirm before installing login-heavy channels such as Twitter, Reddit, XiaoHongShu, LinkedIn, or Xueqiu.
  - [x] Prefer installing only the requested channel.
- [x] Define update behavior.
  - [x] The Skill may mention `agent-reach check-update`.
  - [x] Do not auto-update during unrelated tasks.
  - [x] Offer update instructions when relevant.

## Slice 4: Safety And Permission Boundaries

- [x] Make the Skill explicit about read-vs-write boundaries.
  - [x] Search/read/summarize is in scope.
  - [x] Posting, commenting, liking, following, applying to jobs, or account-changing actions require explicit user request.
- [x] Make cookie handling explicit.
  - [x] Cookies and tokens should stay local.
  - [x] Do not paste cookies into generated reports or artifacts.
  - [x] Prefer Agent Reach configuration commands for storing credentials.
  - [x] Recommend secondary accounts for cookie-based platforms when appropriate.
- [x] Preserve Pixiu permission flow.
  - [x] All external commands go through `shell`.
  - [x] Do not add auto-allow permission rules for Agent Reach in this slice.
- [x] Keep command output source-aware.
  - [x] When generating research artifacts, record source URLs, commands, access time, and relevant backend names.

## Slice 4.5: Hard Stops For Auth And Install Boundaries

Observed behavior: after loading the `agent-reach` Skill, the model correctly checked `agent-reach doctor --json`, but when Agent Reach or XiaoHongShu login state was missing it drifted into direct installs, `xhs-cli` retries, QR login attempts, temporary scraping scripts, private HTTP endpoint guesses, and third-party aggregator probing.

That behavior is not aligned with the Pixiu adapter Skill. Agent Reach should provide a permissioned, authorized routing layer, not an excuse to bypass platform authentication or keep trying unrelated tools.

- [x] Add explicit hard stop conditions to `.pixiu/skills/agent-reach/SKILL.md`.
  - [x] Stop if `agent-reach` is missing and the user has not asked Pixiu to install it.
  - [x] Stop before installing login-heavy or browser-backed channels.
  - [x] Stop when a backend needs login, Cookie/session import, QR scan, captcha, 2FA, browser authorization, API key, account permission, or proxy setup.
  - [x] Stop when login commands hang, start QR/browser automation flows, or download browser automation tooling.
  - [x] Stop when anonymous access is blocked and remaining options are ad hoc scraping/private endpoints.
- [x] In those cases, instruct the agent to call `request_user_action`.
  - [x] Include a XiaoHongShu example with desktop OpenCLI, server xiaohongshu-mcp QR login, and Cookie-Editor/import fallback.
  - [x] Include a resume hint so Pixiu can rerun `agent-reach doctor --json` after the user completes the action.
- [x] Update `references/pixiu-routing.md` with the same user-collaboration stop policy.
- [x] Make it explicit that Pixiu should not bypass authentication through private endpoints, Playwright/Camoufox experiments, third-party aggregator scraping, or repeated blind retries.

## Slice 5: Optional CLI Convenience Later

This is optional and should happen only after the Skill-only path proves useful.

- [x] Consider `pixiu skill install-agent-reach` or similar convenience command.
  - [x] It should copy/sync the Pixiu adapter Skill.
  - [x] It should not run full `agent-reach install` automatically.
  - [x] It can print next-step commands for managed install preview, full approved install, and `agent-reach doctor --json`.
  - [x] Implemented as:

```bash
pixiu skill install-agent-reach
pixiu skill install-agent-reach --yes
pixiu skill install-agent-reach --json
```

- [x] Consider a script under `scripts/` for maintainers.
  - [x] It can sync the Pixiu adapter from Pixiu's checked-in template into `.pixiu/skills/agent-reach`.
  - [x] It should keep `SKILL.md` as the Pixiu adapter, not blindly overwrite it with upstream.
  - [x] Implemented as:

```bash
bun run skills:agent-reach:sync
bun run skills:agent-reach:check
```

  - [ ] A future upstream refresh helper may compare against `/home/gujing/code/Agent-Reach/agent_reach/skill/references`, but should still preserve the Pixiu adapter boundaries.
- [ ] Consider docs in `README.md` or `docs/usage.md` only after the integration is stable.

## Suggested Implementation Order

1. Create the Pixiu adapter Skill and copy references.
2. Run `pixiu skill doctor` and fix discovery/metadata issues.
3. Manually test a simple `skill_search "twitter"` / `skill agent-reach` flow.
4. Test a no-install environment path: the Skill should explain how to install Agent Reach without failing mysteriously.
5. Test an installed environment path: `agent-reach doctor --json` should guide backend selection.
6. Only after this works, decide whether a Pixiu CLI convenience command is worth adding.

## Non-goals

- Do not vendor Agent Reach Python code into Pixiu.
- Do not add Agent Reach as an npm/Bun dependency.
- Do not make Python, pipx, conda, Node global packages, OpenCLI, or browser extensions required for Pixiu startup.
- Do not replace Pixiu `web_search` or `web_fetch`.
- Do not add broad MCP wrapping for Agent Reach in this slice.
- Do not silently install optional social/login-heavy channels.
- Do not modify user-global `~/.agents/skills` or `~/.claude/skills` unless the user explicitly asks.
- Do not create a conda environment unless implementing or testing Agent Reach itself requires it.

## Verification

Skill discovery:

```bash
pixiu skill list
pixiu skill search "twitter"
pixiu skill show agent-reach
pixiu skill doctor
```

Pixiu checks:

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
```

Agent Reach checks, only if the command is installed:

```bash
agent-reach version
agent-reach doctor --json
```

If a Python environment is needed for Agent Reach-specific testing, create an isolated conda environment named for Pixiu rather than changing the system Python:

```bash
conda create -n pixiu-agent-reach python=3.12
conda activate pixiu-agent-reach
pip install -e /home/gujing/code/Agent-Reach
agent-reach version
```

---
name: agent-reach
description: >
  Use this skill when Pixiu needs platform-specific or multi-backend internet
  access through Agent Reach: Twitter/X, Reddit, XiaoHongShu, Bilibili,
  YouTube subtitles/video metadata, GitHub CLI research, RSS, V2EX, LinkedIn,
  Xueqiu, Exa search, or a multi-platform public-opinion/research workflow.
when_to_use: >
  The user asks for a platform-specific internet task, authenticated/browser
  backed channel, video subtitle/metadata workflow, GitHub CLI research, RSS,
  or multi-platform public-opinion research that benefits from Agent Reach's
  channel routing and doctor checks.
when_not_to_use: >
  Do not use for ordinary URL reads, simple web lookup, normal project work,
  or tasks where Pixiu's built-in web_fetch and web_search tools are enough.
triggers:
  - agent-reach
  - Agent Reach
  - Twitter
  - X
  - x.com
  - tweet
  - Reddit
  - XiaoHongShu
  - xiaohongshu
  - xhs
  - 小红书
  - Bilibili
  - B站
  - YouTube
  - GitHub research
  - GitHub code search
  - RSS
  - V2EX
  - LinkedIn
  - Xueqiu
  - 雪球
  - Exa
  - multi-platform research
required_tools:
  - shell
  - skill
  - request_user_action
risk: medium
---

# Agent Reach For Pixiu

Agent Reach is an optional capability layer for platform-specific internet access. In Pixiu, it is a Skill-backed route to external CLIs and MCP-style tools, not a replacement for Pixiu core tools.

## Routing Rules

Use Pixiu built-ins first for lightweight generic work:

- Ordinary URL reading: `web_fetch`
- Simple current web search: `web_search`
- Normal file/project work: Pixiu file, grep, shell, edit, patch, and todo tools

Use this Skill when the task needs Agent Reach's platform channels or multi-backend routing:

- Twitter/X tweets, users, timelines, articles, or search
- Reddit posts, comments, subreddits, or search
- XiaoHongShu notes, comments, search, or feed
- YouTube subtitles, video metadata, video search, or comments
- Bilibili search, video details, subtitles, hot/rank
- GitHub repository, issue, PR, release, Actions, or code research through `gh`
- RSS feed parsing
- V2EX public API topics, replies, users, or nodes
- LinkedIn profiles, companies, jobs, or people search
- Xueqiu stock/community lookup
- Exa semantic search or code context through `mcporter`
- Multi-platform public-opinion or product research

For more Pixiu-specific routing detail, load `references/pixiu-routing.md`.

Browser-use handoff: if a XiaoHongShu Agent Reach backend is blocked by login, QR scan, captcha, 2FA, cookie/session, browser authorization, or the user explicitly chooses browser-use/the browser route, stop Agent Reach backend probing and load `Skill(browser-use)`. Choose a fresh task-specific browser-use session name such as `pixiu-xiaohongshu-tech`; then run `browser-use doctor`, `browser-use --headed --session <session-name> open https://www.xiaohongshu.com`, and `browser-use --session <session-name> state`. A successful `browser-use doctor` is only an availability check; continue to the headed `open` command before reporting browser-use as attempted. Do not keep trying Jina, public/private APIs, third-party aggregators, temporary MCP installs, or scraping scripts after the route is blocked or browser-use is selected.

## First Check

Before platform-specific work, check whether Agent Reach is available:

```bash
agent-reach doctor --json
```

Use the JSON report to select the active backend for multi-backend platforms such as XiaoHongShu, Reddit, Bilibili, and Twitter/X. If `agent-reach` is not installed, use Pixiu's managed tool environment when the user has asked or approved installation.

Safe preview commands:

```bash
pixiu tools env status
pixiu tools install agent-reach
```

Full install command, only after the user wants it:

```bash
pixiu tools install agent-reach --yes
```

After installation, run `agent-reach doctor --json` again. Do not use system `pip`, `--break-system-packages`, or global package mutation.

Do not install all optional Agent Reach channels by default. Install only the channel needed for the user request, and ask before login-heavy or browser-backed channels.

## Hard Stop Conditions

Stop the current execution route and call `request_user_action` before trying workaround commands when any of these happen:

- `agent-reach` is missing and the user has not already asked Pixiu to install it. If the user has asked or approved installation, install it through `pixiu tools install agent-reach --yes`.
- The user explicitly chose browser-use, the browser route, or a visible browser for the blocked platform task. Load `Skill(browser-use)` instead of continuing Agent Reach backends.
- The required platform channel is missing and installation would add external packages, browser tooling, MCP services, or persistent config.
- A backend reports missing login, cookie/session, QR scan, captcha, 2FA, browser authorization, API key, account permission, or proxy setup.
- A login command starts downloading browser automation tooling, hangs while waiting for a QR scan, or asks for interactive user input.
- Anonymous access is blocked by the platform.

Do not bypass platform authentication with ad hoc private endpoints, scraping scripts, Playwright/Camoufox experiments, third-party aggregator scraping, temporary package/MCP installs, or repeated blind retries. If the user explicitly chooses a non-Agent-Reach fallback, keep it read-only, explain the reliability limits, and do not handle credentials outside the configured Agent Reach path.

Example request for XiaoHongShu login:

```json
{
  "title": "需要小红书登录态",
  "reason": "小红书后端需要你授权登录后才能读取搜索、Feed 或热门内容。",
  "category": "auth",
  "instructions": [
    "桌面环境：在浏览器登录小红书，并启用 OpenCLI/Agent Reach 推荐的浏览器通道。",
    "服务器环境：如果 xiaohongshu-mcp 已经配置，可在该服务的二维码登录界面完成扫码；不要在任务中临时安装或配置 MCP。",
    "如果你选择 browser-use/浏览器方案，我会加载 Skill(browser-use)，用一个新的任务专用 browser-use session 以 --headed 打开官方页面；遇到登录、扫码、验证码或 Cookie/session 要求时会停下来让你在浏览器里接管。",
    "完成后保持浏览器窗口打开并回复我继续，我会重新运行 agent-reach doctor --json 或 browser-use --session <session-name> state 并使用可用路线。"
  ],
  "resumeHint": "完成登录、Cookie 导入或浏览器授权后回复“继续”。"
}
```

## Command References

Load only the relevant reference file when needed:

- Search and Exa: `references/search.md`
- Social/community platforms: `references/social.md`
- Video and podcast workflows: `references/video.md`
- Generic web and RSS via Agent Reach: `references/web.md`
- GitHub CLI: `references/dev.md`
- LinkedIn/career: `references/career.md`
- Pixiu-specific boundaries: `references/pixiu-routing.md`

## Safety Boundaries

- Read/search/summarize workflows are in scope.
- Posting, commenting, liking, following, applying to jobs, account changes, repo creation, issue/PR creation, or any other write action requires an explicit user request.
- Keep cookies, tokens, and proxy credentials local. Do not paste credentials into reports, artifacts, final answers, or logs.
- Prefer Agent Reach configuration commands for credentials, for example `agent-reach configure ...`.
- Use secondary accounts for cookie-based social platforms when appropriate.
- Do not clone upstream tool repositories or create persistent tool state inside the Pixiu workspace. Use `~/.agent-reach/` for Agent Reach config and `/tmp/` for transient command output unless the user asks for a Pixiu workspace artifact.

## Evidence

When producing research artifacts or recommendations from Agent Reach data, include source URLs, commands or tools used, access time, and active backend names when available.

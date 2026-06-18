# Pixiu Routing For Agent Reach

This file defines how Agent Reach should coexist with Pixiu's built-in tools.

## Default Tool Choice

Use Pixiu built-ins for small, generic tasks:

| User intent | Preferred route |
| --- | --- |
| Read a normal URL | `web_fetch` |
| Search current web results | `web_search` |
| Inspect local files | `read`, `grep`, `glob` |
| Run a project command | `shell` |
| Create or edit files | `write`, `edit`, `patch` |

Use Agent Reach for platform-specific tasks where generic HTML fetch/search is weak:

| User intent | Agent Reach route |
| --- | --- |
| Search or read Twitter/X | `agent-reach doctor --json`, then `twitter` or OpenCLI backend |
| Search/read Reddit | `agent-reach doctor --json`, then OpenCLI or `rdt` |
| Search/read XiaoHongShu | `agent-reach doctor --json`, then the active configured backend; if login/browser authorization blocks Agent Reach, load `Skill(browser-use)` and open the public page |
| YouTube metadata/subtitles/comments | `yt-dlp`, or `agent-reach transcribe` if no subtitles |
| Bilibili search/video/subtitle | `bili`, OpenCLI subtitle, or API fallback |
| GitHub repo/issue/PR/code research | `gh` |
| RSS feed reading | `feedparser` |
| LinkedIn jobs/profiles/company data | LinkedIn MCP backend or Jina fallback |
| Exa semantic/code search | `mcporter call 'exa...'` |

## Browser-Use Handoff

If a XiaoHongShu Agent Reach backend is blocked by login, QR scan, captcha, 2FA, cookie/session, browser authorization, or the user explicitly chooses browser-use/the browser route, stop Agent Reach backend probing and load `Skill(browser-use)`. Choose a fresh task-specific browser-use session name, then run the full visible-browser sequence: `browser-use doctor`, `browser-use --headed --session <session-name> open https://www.xiaohongshu.com`, and `browser-use --session <session-name> state`. A successful `browser-use doctor` is only an availability check; continue to headed `open` before reporting browser-use as attempted. Do not continue with Jina, public/private API probing, third-party aggregators, temporary MCP installs, or scraping scripts after Agent Reach is blocked or browser-use is selected.

## Install Policy

Agent Reach is optional. Do not silently install it.

If the `agent-reach` command is missing:

1. Tell the user Agent Reach is not installed.
2. Offer Pixiu managed tool environment preview first:

```bash
pixiu tools env status
pixiu tools install agent-reach
```

3. Only run full install after the user clearly wants it:

```bash
pixiu tools install agent-reach --yes
```

4. Optional channels should be installed by name, not all at once, unless the user explicitly requests all channels.

Examples:

```bash
agent-reach install --env=auto --channels=twitter
agent-reach install --env=auto --channels=reddit
agent-reach install --env=auto --channels=opencli
agent-reach install --env=auto --channels=bilibili
```

## User Collaboration Stops

Use `request_user_action` instead of trying more commands when the next step needs the user's account, browser, secret, or approval.

Stop and ask for help when:

- `agent-reach` is missing and the user has not asked to install it. If they approve installation, use `pixiu tools install agent-reach --yes`.
- Installing or enabling a channel would add browser tooling, persistent config, MCP services, or login-heavy platform support.
- A XiaoHongShu backend requires login, QR scan, captcha, 2FA, cookie/session, browser authorization, or the user explicitly chose browser-use/the browser route.
- A tool says login, cookies, QR scan, captcha, 2FA, browser authorization, API key, account permission, or proxy setup is required.
- A login flow starts an interactive browser/QR process or downloads browser automation packages.
- Anonymous access is blocked and the only remaining paths are private endpoints, scraping experiments, or third-party aggregator pages.

For XiaoHongShu, prefer asking the user to provide one of these authorized states:

- desktop: logged-in browser session plus OpenCLI/browser extension path
- server: already-configured xiaohongshu-mcp QR login; do not install or configure MCP inside the task
- browser fallback: user-approved `Skill(browser-use)` route for visible page inspection
- fallback: Cookie-Editor export imported through `agent-reach configure xhs-cookies ...`

Do not attempt to bypass authentication with ad hoc HTTP endpoints, Playwright/Camoufox scripts, or repeated blind retries. If the user explicitly requests a fallback outside Agent Reach, explain that it is less reliable and keep it read-only.

## Doctor Policy

Run `agent-reach doctor --json` at the beginning of platform-specific work, not for every ordinary web lookup.

Use the report to identify:

- channel status
- active backend
- missing install/config steps
- login/cookie requirements

For multi-backend platforms, use the backend selected by `active_backend`. If the selected backend fails, follow the retry chain in the relevant reference file before inventing a new command.

## Credentials And Cookies

Credential handling must remain local and explicit.

- Do not include cookies, tokens, or proxy credentials in generated files.
- Do not quote credentials in final answers.
- Prefer `agent-reach configure ...` commands for storing credentials under Agent Reach's local config.
- Recommend a secondary account for cookie-based platforms when there is account risk.
- Explain when a platform requires browser login, QR login, Cookie-Editor export, or proxy configuration.

## Write Actions

Read/search/summarize workflows are normal.

These actions require an explicit user request:

- posting or commenting
- liking, following, subscribing, starring, or voting
- applying to jobs
- creating GitHub repos, issues, PRs, releases, or comments
- changing account settings

If the user's request is ambiguous, treat it as read-only.

## Evidence And Artifacts

When a task depends on Agent Reach data, record enough evidence for audit:

- source URLs
- command or upstream tool used
- access time
- active backend when available
- output files created

If writing a research Markdown artifact, include a short sources section rather than dumping raw command output.

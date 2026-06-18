# Managed Tools

Pixiu uses a managed tool environment for optional external CLIs such as Agent Reach and browser-use.
This keeps project tasks from mutating system Python or relying on `conda activate` in every shell call.

## Source vs Installed CLI

Cloning a repository is not enough to make its command available.

For example, `/home/gujing/code/Agent-Reach` can exist while this still fails:

```bash
agent-reach doctor --json
```

Pixiu needs the package installed into a tool environment whose `bin` directory is visible to agent shell calls.

## Managed Environment

Default managed tool config:

```jsonc
{
  "tools": {
    "managedEnv": {
      "enabled": true,
      "manager": "conda",
      "name": "pixiu-tools",
      "python": "3.12",
      "autoCreate": true,
      "prependPath": true,
      "autoInstall": "ask"
    }
  }
}
```

Useful commands:

```bash
pixiu tools env status
pixiu tools env create --yes
pixiu tools env path
pixiu tools doctor
```

When `prependPath` is enabled, Pixiu prepends the managed env `bin` directory to every agent shell tool call.
The user shell does not need to show that PATH as active.

## Agent Reach

Install or preview Agent Reach:

```bash
pixiu tools install agent-reach
pixiu tools install agent-reach --yes
```

If a local checkout exists, Pixiu prefers an editable install from:

```text
/home/gujing/code/Agent-Reach
```

Otherwise it installs the `agent-reach` package into the managed environment.
After installation, future Pixiu shell calls can run:

```bash
agent-reach doctor --json
```

without `conda activate`.

## Browser Use

Install or preview the upstream browser-use CLI:

```bash
pixiu tools install browser-use
pixiu tools install browser-use --yes
```

Pixiu installs only the upstream browser-use package into the managed environment:

```text
browser-use[core]
httpx[socks]
```

`httpx[socks]` is included because browser-use can fail at startup when the user shell has SOCKS proxy variables but the managed env lacks socks support.

This does not make browser-use a Pixiu core dependency, and it does not enable browser-use cloud mode, browser profiles, cookies, saved sessions, login automation, or captcha solving. Those remain explicit user-controlled actions.

After installation, future Pixiu shell calls can run:

```bash
browser-use doctor
```

without `conda activate`.

When the user explicitly chooses a visible browser route, the Skill adapter should use a headed session, pause for user-controlled login or verification, then resume against the same session:

```bash
browser-use --headed --session pixiu-xiaohongshu open https://www.xiaohongshu.com
browser-use --session pixiu-xiaohongshu state
```

## Automation Boundary

Pixiu may install tool packages into the managed environment when policy allows it.

Pixiu must ask the user for actions it cannot or should not complete alone:

- login
- QR scan
- captcha
- 2FA
- Cookie or session import
- browser extension authorization
- API token entry
- account permission changes

Agents should use `request_user_action` for these blockers, then rerun the relevant doctor/status command after the user replies.

## Policy

`tools.managedEnv.autoInstall` controls automatic installs:

```text
off   never install automatically
ask   ask before install, the conservative default
allow install into the managed env when a Skill route permits it
```

For Agent Reach routes, if `agent-reach` is missing, Pixiu blocks unrelated workaround commands and allows only user collaboration or managed-env installation.

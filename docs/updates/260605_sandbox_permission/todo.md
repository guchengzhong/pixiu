# 260605 Sandbox Permission TODO

## Goal

Harden the local workspace sandbox and permission layer now that real providers can call tools successfully. The goal is not containers or VMs yet; it is explainable decisions, auditable shell runs, and tests that pin the local boundary.

## First Slice: Explainable Local Sandbox

- [x] Add command execution audit metadata
  - [x] Record command, cwd, exit code, timeout, duration, stdout/stderr byte counts, and truncation flags.
  - [x] Include the permission action/reason/rule that allowed or denied the tool.
- [x] Improve permission explainability
  - [x] Report matched rule index/tool/pattern/action.
  - [x] Preserve the original `ask` action when auto-approved or denied in non-interactive mode.
  - [x] Surface compact permission metadata in tool results.
- [x] Add shell risk classification
  - [x] Classify read-only info commands as low risk.
  - [x] Classify write/delete/network/package/git commands as elevated risk.
  - [x] Use the classification before permission evaluation.
- [x] Strengthen workspace and env tests
  - [x] Shell redirection cannot easily write outside the workspace.
  - [x] `.minicode/tmp` remains usable for temporary task files.
  - [x] Shell env allowlist does not expose provider API keys.
- [x] Harden live smoke safety
  - [x] Add an outer timeout to live smoke cases.
  - [x] Redact secrets in live smoke reports.

## Non-goals

- No container/VM runtime yet.
- No full shell parser.
- No interactive permission prompt UI.
- No policy language rewrite.

## Verification

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
```

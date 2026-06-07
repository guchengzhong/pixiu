# 260605 Live Smoke TODO

## Goal

Add a tiny opt-in live-provider smoke path for minicode. This is not an eval platform yet; it is a confidence check that a real provider can follow the agent protocol, call core tools, and produce inspectable task evidence.

## First Slice: Opt-In Live Provider Smoke

- [x] Add an opt-in live smoke script
  - [x] Add a command such as `bun run smoke:live`.
  - [x] Require an explicit provider API key environment variable.
  - [x] Fail fast with a clear message when the key is missing.
- [x] Add plain-text real provider smoke
  - [x] Ask for a small final answer that requires no tools.
  - [x] Verify the run reaches a final assistant message.
- [x] Add tool-call real provider smoke
  - [x] Ask the agent to write and then summarize a workspace file.
  - [x] Verify the expected file exists in the session workspace.
- [x] Add temporary-script or live-data smoke
  - [x] Ask the agent to use shell or a temporary script under `.minicode/tmp/`.
  - [x] Verify the final artifact records command/source/access-time evidence.
- [x] Generate a smoke report
  - [x] Write a Markdown report.
  - [x] Include provider/model, session ids, tool calls, produced files, pass/fail state, and failure reason.
- [x] Keep default tests offline
  - [x] `bun test` must not call a real provider.
  - [x] Live smoke must only run when explicitly invoked.
- [x] Test the smoke script itself with a fake provider
  - [x] Use the existing fake OpenAI-compatible provider or a small local equivalent.
  - [x] Cover report generation and failure reporting without network or real API cost.

## Non-goals

- No benchmark scoring.
- No long-running eval suite.
- No automatic CI live-provider run.
- No real SkillHub or third-party MCP smoke in this slice.

## Verification

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
MINICODE_API_KEY=... PATH=.tools/bun/bin:$PATH bun run smoke:live
```

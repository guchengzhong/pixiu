# 260605 Harness TODO

## Goal

Build a small subprocess harness for minicode so runtime changes can be tested through the same path users run:

```text
argv -> config load -> provider stream -> runner -> tools -> session store -> CLI output
```

This is not a benchmark or eval platform yet. It is a regression harness for the product spine.

## References

- opencode `packages/opencode/test/lib/cli-process.ts`: real CLI subprocess, isolated env, typed helpers.
- opencode `packages/opencode/test/lib/llm-server.ts`: local fake OpenAI-compatible streaming server.
- opencode `packages/opencode/test/cli/run/run-process.test.ts`: non-interactive run subprocess tests.
- opencode `packages/opencode/test/cli/smokes/read-only.test.ts`: cheap smoke tier for shared CLI wiring.

## First Slice

- [x] Add `test/harness/llm-server.ts`
  - [x] Start a local OpenAI-compatible `/chat/completions` endpoint.
  - [x] Queue deterministic text responses.
  - [x] Queue deterministic tool calls.
  - [x] Queue HTTP/provider errors.
  - [x] Record request bodies for assertions.
- [x] Add `test/harness/minicode-process.ts`
  - [x] Create an isolated temp project.
  - [x] Write `minicode.jsonc` pointing at the fake LLM server.
  - [x] Spawn the real minicode CLI entry with Bun.
  - [x] Capture stdout, stderr, exit code, and duration.
  - [x] Provide `run`, `spawn`, `expectExit`, and `parseJsonEvents` helpers.
- [x] Add subprocess tests
  - [x] `run` prints a successful final response.
  - [x] `run --json` emits parseable JSONL events.
  - [x] Tool-call loop writes into `workspace/<session-id>`, not repo root.
  - [x] `run --session` reuses the prior workspace.
  - [x] Provider error exits without hanging and surfaces the error.
  - [x] Read-only smoke commands run in the isolated project.

## Second Slice: Scenario Harness

Goal: make the harness better than a subprocess helper. A test should describe an agent behavior scenario, and the harness should run the real CLI, inspect the LLM traffic, inspect the session workspace, and leave useful failure evidence.

- [x] Enhance `test/harness/llm-server.ts`
  - [x] Match queued replies against request bodies.
  - [x] Queue reasoning deltas and token usage metadata.
  - [x] Queue raw SSE chunks.
  - [x] Queue delayed replies.
  - [x] Queue stream parse errors.
  - [x] Queue connection reset and hanging responses for timeout tests.
- [x] Add `test/harness/scenario.ts`
  - [x] Provide `text`, `tool`, `httpError`, `streamError`, `hang`, and request-match helpers.
  - [x] Run scenarios through the real CLI fixture.
  - [x] Assert stdout/stderr snippets.
  - [x] Assert JSONL event type sequences.
  - [x] Assert workspace files under `workspace/<session-id>`.
  - [x] Assert LLM request counts and request content.
  - [x] Include stdout, stderr, events, sessions, workspace tree, and LLM hits in failure messages.
- [x] Add scenario tests
  - [x] Weather-style task calls shell, writes markdown, and emits friendly traces.
  - [x] Request matching can choose replies based on prior tool results.
  - [x] Stream parse errors surface cleanly without hanging.
  - [x] Hanging providers are killed by subprocess timeout.
  - [x] Parallel scenarios keep workspace files isolated.

## Third Slice: Harness Hardening

- [x] Add fake LLM assertion helpers
  - [x] `calls()` returns observed request count.
  - [x] `inputs()` returns request bodies for assertions.
  - [x] `pending()` returns queued response count.
  - [x] `wait(count)` resolves when enough requests arrive and can timeout.
- [x] Improve evidence bundles
  - [x] Save session JSONL file contents.
  - [x] Save workspace file contents.
  - [x] Redact common API key/token/secret patterns in saved evidence.
- [x] Make spawned CLI processes safe
  - [x] Return a managed spawn handle with `result`, `close`, and `kill`.
  - [x] Drain stdout/stderr immediately.
  - [x] Auto-close unfinished spawned handles during fixture teardown.
- [x] Add hardening tests
  - [x] Assert fake LLM calls/inputs/pending/wait helpers.
  - [x] Assert evidence bundles include session and workspace contents.
  - [x] Assert spawned handles are closed by fixture teardown.

## Non-goals

- No real provider calls in default tests.
- No long-running server/TUI harness yet.
- No model quality evaluation yet.
- No recording/replay of real providers yet.

## Verification

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
```

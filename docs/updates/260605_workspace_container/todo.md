# 260605 Workspace Container TODO

## Goal

Prepare minicode for Manus-like session isolation by separating "where the session files live" from "where shell/code executes". This slice should keep the current workspace-directory backend as the default, while introducing the shape needed for container and later VM backends.

## First Slice: Workspace Backend Boundary

- [ ] Define a `WorkspaceBackend` abstraction
  - [ ] Create session workspace.
  - [ ] Resolve session cwd and metadata.
  - [ ] Execute shell commands through the selected backend.
  - [ ] Close or cleanup session resources when needed.
- [ ] Keep the current directory workspace as the default backend
  - [ ] Preserve `sandbox.mode: "workspace"` behavior.
  - [ ] Keep files under `workspace/<session-id>`.
  - [ ] Keep current path guard and permission behavior unchanged.
- [ ] Add a container backend shape without making Docker mandatory
  - [ ] Draft config shape for `sandbox.mode: "container"`.
  - [ ] Define image, workdir mount, env allowlist, timeout, and cleanup knobs.
  - [ ] Use a fake container runner in default tests.
- [ ] Add opt-in real container smoke later
  - [ ] Real Docker/Podman smoke must be explicit.
  - [ ] Default `bun test` must not require Docker.
- [ ] Add workspace status and cleanup planning
  - [ ] Show session workspace path.
  - [ ] Show backend type.
  - [ ] Record whether cleanup is pending, complete, or failed.
- [ ] Add failure evidence
  - [ ] Container start failure.
  - [ ] Command failure.
  - [ ] Timeout.
  - [ ] Cleanup failure.

## Non-goals

- No VM backend in this slice.
- No mandatory Docker dependency.
- No browser automation yet.
- No MCP server isolation yet.
- No automatic cleanup policy that could delete user-visible work without an explicit decision.

## Verification Plan

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
```

Future opt-in container smoke should look like:

```bash
MINICODE_CONTAINER_SMOKE=1 PATH=.tools/bun/bin:$PATH bun run smoke:container
```

# 260605 Skills TODO

## Goal

Make local Skills a dependable instruction layer for minicode. Skills should be easy to discover, safe to load, diagnosable when malformed, and useful to the agent without bloating the core tool set.

## References

- opencode `packages/opencode/src/skill/index.ts`: multi-source discovery, frontmatter validation, duplicate handling, available skill list.
- opencode `packages/opencode/src/tool/skill.ts`: skill tool returns the instruction body with base directory context and nearby files.
- minicode `src/skills/*`: current minimal loader and `skill` tool.
- minicode harness: real CLI subprocess and fake LLM scenarios should verify agent-facing behavior.

## First Slice: Local Skills Industrial Baseline

- [x] Harden skill discovery
  - [x] Parse `SKILL.md` frontmatter predictably.
  - [x] Validate `name` and `description` with clear diagnostics.
  - [x] Keep deterministic source precedence based on configured `skills.paths`.
  - [x] Detect duplicate skill names and keep the first source while reporting the ignored duplicates.
  - [x] Attach source metadata: root path, root index, relative path, skill path, and root directory.
- [x] Improve local skill loading
  - [x] Include a bounded list of reference files under the skill root.
  - [x] Keep `SKILL.md` loading separate from reference-file loading.
  - [x] Keep path-escape protection for skill-relative files.
  - [x] Reject empty or absolute reference paths before reading.
- [x] Improve the `skill` tool
  - [x] Default call loads the main `SKILL.md`.
  - [x] Optional `path` loads a safe skill-relative reference file.
  - [x] Main result tells the agent which reference files can be loaded next.
  - [x] Tool metadata includes source and file-list context for trace/debug evidence.
- [x] Improve CLI ergonomics
  - [x] `minicode skill search <query>` searches installed local skills.
  - [x] `minicode skill search --remote <query>` keeps SkillHub search explicit.
  - [x] `minicode skill list --json` exposes diagnostics for invalid/duplicate skills.
- [x] Add tests
  - [x] Loader tests for metadata parsing, source metadata, file list, local search, duplicates, invalid skills, and path safety.
  - [x] Tool tests for main skill loading and reference-file loading.
  - [x] CLI tests for local list/search/show.
  - [x] Scenario test proving the LLM sees available skills and can call the `skill` tool.

## Second Slice: SkillHub Install Provenance

- [x] Harden remote install planning
  - [x] Normalize and validate remote file paths before writing.
  - [x] Reject absolute paths, empty paths, NUL bytes, and `..` traversal.
  - [x] Generate a safe target directory name from the remote skill name.
  - [x] Show planned target directory and file list before install.
- [x] Record install provenance
  - [x] Write `.source.json` with schema version, install time, installer name, remote id/name/source/version/update time, target directory, and installed files.
  - [x] Record installed file bytes and SHA-256 digest.
  - [x] Return manifest path and manifest data from `installRemoteSkill`.
- [x] Improve CLI/tool output
  - [x] `minicode skill install <id>` prints a reviewable plan and requires `--yes`.
  - [x] `minicode skill install <id> --yes` prints target directory, manifest path, and installed files.
  - [x] `skillhub_install` tool reports the same manifest metadata.
- [x] Add tests
  - [x] Provider tests for manifest/provenance output.
  - [x] Provider tests for remote path traversal rejection.
  - [x] CLI tests for install plan and confirmed install.

## Non-goals

- No real SkillHub network calls in default tests.
- No remote skill update/uninstall workflow yet.
- No MCP prompt/resource integration yet.
- No automatic remote skill search by the default agent.

## Verification

```bash
PATH=.tools/bun/bin:$PATH bun run typecheck
PATH=.tools/bun/bin:$PATH bun test
```

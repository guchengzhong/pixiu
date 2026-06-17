# Slice 10: Workbench Lifecycle & Navigation Polish

## Goal

After Slice 8 semantic activity, Pixiu already has the core observability layers:

* Todo progress
* Run status
* Semantic activity
* Raw trace / files / evidence / artifacts

Now the main problem is workbench lifecycle and navigation polish.

Current issues:

1. The UI reacts quickly, but interactions feel stiff and abrupt.
2. Project and session concepts are not clearly separated.
3. Sessions cannot be renamed, deleted, or moved between projects.
4. Projects cannot be created, renamed, deleted, or used to group sessions.
5. Sidebar navigation entries such as Skills / MCP / Workspace are visible but mostly non-functional.
6. Top-right controls are redundant: `Status`, `Activity`, `Inspector`, `API` should be simplified.
7. File/session/project state restoration is incomplete.
8. The workbench needs to feel like a coherent product, not only a debug UI.

This slice should focus on product hardening, not new agent intelligence.

---

## Design Principles

### 1. Project and session must be separate concepts

A project is a workspace-level grouping unit.

A session is a conversation/run history under a project.

Expected model:

```text
Project
  - id
  - name
  - rootPath
  - createdAt
  - updatedAt
  - sessions[]

Session
  - id
  - projectId
  - title
  - workspacePath
  - createdAt
  - updatedAt
  - metadata
```

A project can contain multiple sessions.

A session belongs to exactly one project.

The sidebar should make this relationship clear.

---

### 2. UI should be smoother, not just faster

Do not over-engineer animation, but avoid abrupt jumps.

Add small transitions for:

* sidebar collapse / expand
* right inspector open / close
* tab switching
* session selection
* modal open / close
* context menu open / close
* project/session list updates

Use simple CSS transitions. Do not introduce a heavy animation framework unless already present.

Suggested duration:

```text
120ms - 180ms
```

Keep interactions fast and subtle.

---

### 3. Navigation entries should either work or be visibly disabled

Current sidebar has:

* Projects
* Skills
* MCP
* Workspace
* Settings / API

If they are clickable, they must show a real panel.

If not implemented yet, show a clear placeholder instead of doing nothing.

Bad:

```text
click Skills -> no response
```

Acceptable first version:

```text
click Skills -> opens Skills panel with installed skills / empty state / coming soon note
```

---

### 4. Use one right-side Inspector toggle

Top-right buttons are currently redundant.

Current:

```text
Status | Activity | Inspector | API
```

Target:

```text
Inspector
```

Inside Inspector, use tabs:

```text
Activity | Files | Evidence | Status | API
```

Or:

```text
Trace | Files | Evidence | Status | API
```

But the top bar should not have multiple competing inspector buttons.

The top bar should mainly show:

* project path
* model/provider
* edit mode
* run status
* API status
* Inspector toggle

---

### 5. Do not break observability layers

This slice must not break:

* Slice 7 run status
* Slice 8 semantic activity
* Todo progress
* Raw trace
* Permission flow
* Files/artifacts/evidence cards

This is product hardening, not a rewrite.

---

## Scope

This slice is divided into four sub-slices.

Recommended order:

```text
10A: Project/session data model and APIs
10B: Sidebar lifecycle actions
10C: Workbench navigation panels
10D: UI smoothness and inspector cleanup
```

Implement incrementally.

---

# Slice 10A: Project and Session Lifecycle Model

## Goals

Add first-class project/session lifecycle support.

## Tasks

### 10A.1 Define shared project/session types

Add or update shared API types.

Suggested types:

```ts
export type UiProjectSummary = {
  id: string
  name: string
  rootPath: string
  createdAt: string
  updatedAt: string
  sessionCount: number
  lastSessionId?: string
}

export type UiSessionSummary = {
  id: string
  projectId?: string
  title: string
  workspacePath?: string
  createdAt: string
  updatedAt: string
  finishStatus?: TerminalRunStatus
  preview?: string
  artifactCount?: number
  activityCount?: number
}
```

If similar types already exist, extend them instead of duplicating.

---

### 10A.2 Add project store support

Implement project persistence.

Possible storage:

```text
.pixiu/projects.json
```

or existing workspace/session metadata store if appropriate.

Project metadata should survive restart.

Minimum project fields:

```ts
{
  id,
  name,
  rootPath,
  createdAt,
  updatedAt
}
```

---

### 10A.3 Add project APIs

Add server endpoints or existing API handlers for:

```text
GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId
```

Required operations:

* list projects
* create project
* rename project
* delete project
* get current project

Delete behavior:

First version can be conservative:

```text
Delete project only removes project metadata if it has no sessions.
```

If project contains sessions, return an error message:

```text
Project is not empty. Move or delete sessions first.
```

Avoid accidentally deleting user files.

---

### 10A.4 Add session APIs

Add or extend APIs for:

```text
GET    /api/sessions?projectId=...
POST   /api/sessions
PATCH  /api/sessions/:sessionId
DELETE /api/sessions/:sessionId
POST   /api/sessions/:sessionId/move
```

Required operations:

* list sessions under project
* create session under project
* rename session
* delete session
* move session to another project

Delete behavior:

First version can move deleted sessions to a local trash folder or mark deleted in metadata.

If physical deletion is implemented, confirm that only Pixiu session files are deleted, not project workspace files.

---

### 10A.5 Session title behavior

Session title should be editable.

Initial session title can be:

1. first user message summary
2. fallback to `New chat`
3. user-renamed title takes priority and should not be overwritten automatically

Add metadata:

```ts
titleSource?: "auto" | "user"
```

If titleSource is `user`, do not auto-rename.

---

### 10A.6 Backward compatibility

Existing sessions without projectId should be assigned to current/default project.

Rules:

```text
if session.projectId missing:
  assign to current project
```

Do not break old session restore.

---

# Slice 10B: Sidebar Lifecycle Actions

## Goals

Make sidebar useful as a real project/session manager.

## Tasks

### 10B.1 Project list behavior

Sidebar should show:

```text
Projects
  Current project
  Other projects
```

Current project card should show:

* project name
* root path
* session count

---

### 10B.2 Session list grouped by project

Session list should show sessions for the selected project.

Each session item should show:

* title
* updated time
* short path or preview
* selected state
* optional status badge if last run errored/cancelled

---

### 10B.3 Session actions

Each session item should have a context menu or inline menu.

Actions:

```text
Rename
Move to project
Delete
Copy session path
```

Minimum viable first version:

* Rename
* Delete

Move can be added if project API is ready.

---

### 10B.4 Project actions

Each project should have actions:

```text
Rename project
New session in project
Delete project
Copy project path
```

Minimum viable first version:

* Rename
* New session
* Delete empty project

---

### 10B.5 Drag-and-drop sessions between projects

Support dragging a session from one project to another.

First version can be simple:

* drag session item
* drop on project item
* call move session API
* update sidebar

If DnD is too much for this slice, implement move via context menu first and leave DnD as TODO.

Do not block the entire slice on drag-and-drop.

---

### 10B.6 Search sessions

Search should filter sessions by:

* title
* first user message preview
* workspace path
* date

Search should not destroy grouping.

Empty state:

```text
No sessions match your search.
```

---

# Slice 10C: Workbench Navigation Panels

## Goals

Sidebar navigation entries should open real panels.

Current entries:

```text
Projects
Skills
MCP
Workspace
Settings / API
```

They should all respond when clicked.

---

## 10C.1 Projects panel

Projects panel should show:

* current project details
* project list
* create project
* rename project
* delete empty project
* sessions in project

This can reuse sidebar components.

---

## 10C.2 Skills panel

Skills panel should show installed skills.

Minimum fields:

* skill name
* description
* path
* reference count
* enabled/available state if supported

Empty state:

```text
No skills found.
Create a SKILL.md file or configure skill paths.
```

Actions:

* open skill file/path if possible
* refresh skills

Do not implement full SkillHub here unless already available.

---

## 10C.3 MCP panel

MCP panel should show configured MCP servers.

Minimum fields:

* server name
* command/url
* enabled/disabled
* connection status if available
* tool count if available

Empty state:

```text
No MCP servers configured.
```

Actions:

* refresh MCP
* open configuration

Do not implement complex MCP editing unless current config API already supports it.

---

## 10C.4 Workspace panel

Workspace panel should show:

* project root
* uploaded files
* generated artifacts
* referenced files
* recent modified files

Actions:

* open file preview if supported
* copy path
* reveal in workspace list
* remove uploaded file reference

Important:

Removing an uploaded/reference file from session should not delete the original file unless explicitly requested.

---

## 10C.5 Settings / API panel

Settings / API panel should show:

* current provider
* model
* base URL
* API readiness
* edit mode
* permission mode
* save/test config actions if already supported

The existing Configure API modal can be reused or embedded.

---

# Slice 10D: Inspector and UI Smoothness

## Goals

Simplify top-right controls and make panel transitions smoother.

---

## 10D.1 Consolidate top-right buttons

Replace:

```text
Status | Activity | Inspector | API
```

with:

```text
Inspector
```

Top bar may still show small status pills:

```text
Ready
API ready
```

But only one button should open/close the right inspector.

Inside inspector, use tabs:

```text
Activity
Files
Evidence
Status
API
```

If current tabs are:

```text
trace | files | evidence | status
```

Consider renaming `trace` to `activity` or making semantic Activity the default tab.

Raw trace should be accessible under:

```text
Raw Details
```

or a nested raw trace section.

---

## 10D.2 Smooth sidebar collapse

Sidebar collapse/expand should animate width and opacity lightly.

Avoid layout jumping.

Suggested behavior:

```text
expanded: full sidebar
collapsed: icon rail only
```

The selected project/session should remain stable after collapse/expand.

---

## 10D.3 Smooth right inspector open/close

Right inspector should slide or fade smoothly.

Do not abruptly resize the main chat area.

Use CSS transition on width / transform / opacity.

Keep it fast:

```text
transition: 150ms ease
```

---

## 10D.4 Smooth tab switching

Inspector tabs and workbench nav panels should switch without harsh layout jumps.

Minimum:

* preserve scroll position where reasonable
* avoid full-page remount if not necessary
* show empty states instead of blank panels

---

## 10D.5 Button and menu polish

Add consistent hover/focus/active states.

Important interactive elements:

* sidebar nav items
* session items
* project items
* context menu buttons
* inspector tabs
* collapse buttons
* top bar Inspector button

Keyboard accessibility:

* Escape closes modals/context menus
* Enter confirms rename
* blur or Escape cancels rename

---

# File Lifecycle Requirements

## Uploaded file refs

Uploaded file references should persist in session metadata.

On session restore:

* Files used card should restore uploaded/referenced files.
* Workspace panel should show session file references.
* Missing files should be shown as missing, not crash the UI.

---

## Generated artifacts

Artifacts should persist in session metadata or be discoverable from workspace output files.

Each artifact item should include:

```ts
{
  path,
  kind,
  createdAt,
  sourceToolCallId?,
  exists?
}
```

On session restore:

* artifact cards should still show generated files
* missing artifacts should be marked unavailable

---

## File delete semantics

Never accidentally delete project files.

Distinguish:

```text
Remove reference from session
Delete Pixiu-generated artifact
Delete physical file
```

First version should implement only:

```text
Remove reference from session
```

Physical deletion should require explicit confirmation and can be deferred.

---

# Data Migration / Compatibility

Existing sessions/projects should keep working.

Requirements:

1. Existing session list still loads.
2. Sessions without projectId attach to default/current project.
3. Existing activity/todo/run status metadata is preserved.
4. Missing project metadata should auto-create a default project.
5. Deleting/renaming project should not break existing session files.

---

# Testing

Add or update tests.

## Server/API tests

Cover:

* list projects
* create project
* rename project
* delete empty project
* prevent deleting non-empty project
* list sessions by project
* create session under project
* rename session
* delete session
* move session between projects
* backward compatibility for sessions without projectId
* restore uploaded file refs
* restore artifacts
* missing file refs do not crash

## Client/UI tests

Cover:

* sidebar renders projects and sessions
* clicking Skills opens Skills panel
* clicking MCP opens MCP panel
* clicking Workspace opens Workspace panel
* clicking Settings/API opens settings panel
* session rename UI
* session delete UI
* project rename UI
* Inspector toggle works
* only one top-right Inspector toggle is needed
* Activity/Files/Evidence/Status/API tabs work
* active run status still disables Composer correctly
* run status is not broken by inspector changes

## Manual checks

Run through these flows:

### Flow 1: basic session lifecycle

1. Create new session.
2. Send a message.
3. Rename session.
4. Switch to another session.
5. Switch back.
6. Confirm title, messages, activity, files, artifacts restore.

### Flow 2: project lifecycle

1. Create project.
2. Create session under project.
3. Rename project.
4. Move session to another project.
5. Delete empty project.
6. Confirm sessions do not disappear unexpectedly.

### Flow 3: workbench navigation

1. Click Projects.
2. Click Skills.
3. Click MCP.
4. Click Workspace.
5. Click Settings/API.
6. Confirm each opens a real panel or meaningful empty state.

### Flow 4: inspector cleanup

1. Open Inspector.
2. Switch Activity / Files / Evidence / Status / API.
3. Collapse Inspector.
4. Reopen Inspector.
5. Confirm current tab and layout are stable.

### Flow 5: smoothness

1. Collapse/expand sidebar.
2. Open/close inspector.
3. Rename session.
4. Open context menu.
5. Switch panels.
6. Confirm no abrupt blank flashes or major layout jumps.

---

# Acceptance Criteria

Slice 10 is done when:

1. Project and session are clearly separated.
2. Sessions can be renamed and deleted.
3. Projects can be created and renamed.
4. Empty projects can be deleted safely.
5. Sessions can be associated with projects.
6. Sidebar session list is project-aware.
7. Skills/MCP/Workspace/Settings navigation entries open real panels or meaningful placeholders.
8. Top-right controls are simplified to one Inspector toggle plus status pills.
9. Inspector contains Activity/Files/Evidence/Status/API tabs.
10. Sidebar and Inspector transitions feel smooth.
11. Uploaded file refs and artifacts survive session restore.
12. Old sessions still load.
13. No project files are physically deleted by accident.
14. Slice 7 run status still works.
15. Slice 8 semantic activity still works.
16. TypeScript passes.
17. Existing tests pass, or any unrun tests are clearly explained.

---

# Non-goals

Do not implement these in Slice 10 unless trivial:

* Full multi-agent/subagent system
* Full SkillHub marketplace
* Complex MCP server editor
* Cloud sync
* User accounts
* Multi-user collaboration
* Advanced file diff UI
* Heavy animation framework
* Destructive physical file deletion

---

# Final Report Required

After implementation, please output:

1. Modified files.
2. New project/session data model.
3. New or changed API endpoints.
4. Sidebar lifecycle behavior.
5. Workbench navigation behavior.
6. Inspector simplification details.
7. File reference/artifact persistence behavior.
8. Smoothness/transition changes.
9. Backward compatibility handling.
10. Test results.
11. Known limitations or follow-up TODOs.

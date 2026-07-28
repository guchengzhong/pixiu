# Pixiu Workbench UI Layout Spec

This reference describes the target Pixiu browser workbench.

## Page Structure

Use a desktop-first workbench with two persistent regions. The inspector is
contextual and must not permanently compete with the conversation for space.

```text
+--------------+-----------------------------------------------+
| Left sidebar | Top bar: context, model, status, inspector    |
|              +-----------------------------+-----------------+
| Projects     | Conversation                | Inspector       |
| Sessions     |                             | when opened     |
| Workspace    | Messages                    | Activity        |
| Skills / MCP | Inline tools and artifacts  | Changes         |
| Settings     | Composer                    | Files           |
+--------------+-----------------------------+-----------------+
```

The outer shell owns only the sidebar and main area. The inspector belongs to
the main content grid, starts closed, remembers its width, and becomes an
overlay at constrained widths.

## Left Sidebar

The sidebar should help users understand where they are without becoming a
second dashboard.

Recommended sections:

1. New chat and session search
2. Projects
3. Sessions for the selected project
4. Workspace, Skills, MCP, Projects, and Settings navigation

Project and session actions belong in compact menus. The sidebar can collapse
to an icon rail on wide screens. At constrained widths it becomes a drawer.

## Center Workbench

The center is the primary task surface. A response may include:

1. A natural-language answer rendered as Markdown
2. Readable lists, tables, links, and highlighted code
3. Collapsible tool calls attached to the assistant turn that produced them
4. File references and artifacts attached to the same turn
5. A clear pending, failure, or permission state when applicable

Do not render empty summary-card grids below every response. Skills, MCP, and
project management belong in dedicated workbench views. Workspace state and
long execution details belong in the inspector.

## Right Inspector

The inspector is Pixiu's observability and workspace surface. It has three
tabs:

### Activity

Show structured task progress first and keep raw execution details in a
secondary disclosure. Each event may expose status, label, detail, and error
state.

### Changes

Show the configured project root, Git branch, changed files, structured status,
and a single-file diff. Support staged, unstaged, untracked, deleted, renamed,
type-changed, and conflicted states.

### Files

Show a collapsible project file tree, safe text preview, and actions to copy or
reference a path in chat. Session uploads, generated artifacts, and evidence
remain available in a secondary disclosure.

The inspector can collapse and resize on wide screens. Its size must not alter
the outer page width or cause horizontal overflow.

## Top Bar

Keep the top bar compact:

* current project and conversation
* current model
* one run-status indicator
* inspector toggle

Keep permission mode in the composer, where it directly affects the next run.
Avoid a row of status pills.

## Composer

The composer supports:

* a self-sizing text input
* file attachment and referenced-file removal
* permission mode
* send
* stop while a run is active

Enter submits, Shift+Enter inserts a newline, and IME composition must never
submit prematurely.

## Visual Style

Prefer:

* a light neutral canvas with clear surface hierarchy
* quiet gray borders and restrained shadows
* one blue interaction accent plus semantic success, warning, and danger colors
* 8px maximum radius for cards and panels
* compact controls and consistent spacing
* visible keyboard focus

Avoid:

* heavy gradients or decorative background shapes
* nested cards and empty card walls
* oversized headings inside work surfaces
* unclear icon-only actions
* hidden execution state

## Responsive Behavior

Validate at 1440x900, 1024x768, and 390x844.

Minimum behavior:

* the center conversation remains the primary surface
* navigation and inspector become independent drawers below the workbench breakpoint
* closed drawers are not focusable or pointer-interactive
* the top bar and composer remain single-purpose and do not overlap
* Markdown tables, code, file paths, trees, and diffs scroll locally
* the document itself has no horizontal overflow
* use dynamic viewport height and mobile safe-area insets

## Implementation Notes

Prefer existing project, session, activity, workspace, Git, and evidence APIs.
Do not add mock data to production presentation components. Deterministic
fixtures belong only in tests.

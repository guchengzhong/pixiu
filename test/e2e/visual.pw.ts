import type { Page, Route } from "@playwright/test"

import { test, expect } from "./fixtures"

test.describe("visual regression", () => {
  test("keeps the collapsed desktop sidebar compact", async ({ page, openPixiu }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Desktop-only collapsed sidebar")
    await openPixiu()

    const sidebar = page.locator(".workbench-sidebar")
    const footer = sidebar.locator(".sidebar-footer")
    await page.getByRole("button", { name: "Collapse sidebar" }).click()
    await expect(page.locator(".workbench-shell")).toHaveClass(/sidebar-collapsed/)
    await expect(sidebar).toHaveCSS("width", "68px")

    const [sidebarBox, footerBox, buttonBoxes] = await Promise.all([
      sidebar.boundingBox(),
      footer.boundingBox(),
      footer.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON())),
    ])
    expect(sidebarBox).not.toBeNull()
    expect(footerBox).not.toBeNull()
    expect(sidebarBox?.width).toBe(68)
    expect(footerBox?.height).toBeLessThan(220)
    expect(Math.abs((sidebarBox?.y ?? 0) + (sidebarBox?.height ?? 0) - ((footerBox?.y ?? 0) + (footerBox?.height ?? 0)))).toBeLessThanOrEqual(1)
    expect(buttonBoxes.every((box) => box.height <= 40)).toBe(true)

    await expect(page).toHaveScreenshot("pixiu-shell-sidebar-collapsed.png", {
      fullPage: true,
      mask: [page.getByText(/\/tmp\/pixiu-e2e-[^/]*\/project/)],
      maskColor: "#ececec",
    })
  })

  test("renders Markdown, highlighted code, tool output, and an artifact in one turn", async ({ page, openPixiu, uiApi }) => {
    await uiApi.seedSession("Rich visual fixture", "Run the rich visual fixture")
    await openPixiu()
    await selectSession(page, "Rich visual fixture")

    const assistantTurn = page.locator(".message.assistant").last()
    await expect(assistantTurn.getByRole("heading", { name: "UI review complete" })).toBeVisible()
    await expect(assistantTurn.getByRole("button", { name: "Copy code" })).toBeVisible()
    const tool = assistantTurn.locator("details.turn-tool")
    await expect(tool).toContainText("write")
    await tool.locator("summary").click()
    await expect(tool.locator("pre")).toContainText("reports/ui-check.md")
    await expect(assistantTurn.getByRole("button", { name: "reports/ui-check.md" })).toBeVisible()
    await tool.locator("summary").click()
    await expect(tool).not.toHaveAttribute("open", "")

    await expect(assistantTurn).toHaveScreenshot("pixiu-rich-conversation.png")
  })

  test("shows stable Changes and Files inspector states", async ({ page, openPixiu, uiApi }) => {
    const sessionId = await uiApi.createSession("Changes visual fixture")
    await installWorkspaceFixture(page, sessionId)
    await openPixiu()
    await selectSession(page, "Changes visual fixture")

    await page.getByRole("button", { name: "Open inspector" }).click()
    const inspector = page.locator("#pixiu-inspector")
    await expect(inspector).toBeVisible()

    await inspector.locator("#inspector-tab-changes").click()
    await expect(inspector.getByText("src/app.ts", { exact: true }).first()).toBeVisible()
    await expect(inspector.locator(".workspace-diff-content")).toContainText('+export const theme = "workbench"')
    await expect(inspector).toHaveScreenshot("pixiu-inspector-changes.png")

    await inspector.locator("#inspector-tab-files").click()
    await inspector.locator('.workspace-tree-entry[title="src"]').click()
    await inspector.locator('.workspace-tree-entry[title="src/app.ts"]').click()
    await expect(inspector.locator(".workspace-file-content")).toContainText('export const theme = "workbench"')
    await expect(inspector).toHaveScreenshot("pixiu-inspector-files.png")
  })

  test("shows the permission review dialog in context", async ({ page, openPixiu, uiApi }) => {
    await uiApi.createSession("Permission visual fixture")
    await openPixiu()
    await selectSession(page, "Permission visual fixture")
    await page.getByRole("combobox", { name: "Permission mode" }).selectOption("default")
    await page.getByRole("textbox").last().fill("Run the permission fixture for visual review")
    await page.getByRole("button", { name: "Send message", exact: true }).click()

    const dialog = page.getByRole("dialog", { name: "Permission required" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("write", { exact: true })).toBeVisible()
    const temporaryPath = dialog.locator(".permission-context code")
    await expect(temporaryPath).toBeVisible()
    await expect(page).toHaveScreenshot("pixiu-permission-modal.png", {
      fullPage: true,
      mask: [temporaryPath, page.locator(".session-row small:visible")],
      maskColor: "#ececec",
    })

    await dialog.getByRole("button", { name: "Deny" }).click()
    await expect(dialog).toHaveCount(0)
  })
})

async function selectSession(page: Page, title: string) {
  const session = page.getByRole("button", { name: new RegExp(title) })
  if (!(await session.isVisible())) {
    await page.getByRole("button", { name: "Open navigation" }).click()
    await expect(page.locator(".workbench-sidebar.mobile-open")).toBeVisible()
  }
  await session.click()
}

async function installWorkspaceFixture(page: Page, sessionId: string) {
  const revision = "1".repeat(64)
  const hunkId = "2".repeat(64)
  await page.route(`**/api/sessions/${sessionId}/files/content**`, async (route) => {
    const content = 'export const theme = "workbench"\nexport const density = 2\n'
    await fulfill(route, {
      path: new URL(route.request().url()).searchParams.get("path") ?? "src/app.ts",
      size: content.length,
      updatedAt: "2026-07-28T08:00:00.000Z",
      content,
    })
  })
  await page.route(`**/api/sessions/${sessionId}/changes**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/changes/diff")) {
      await fulfill(route, {
        path: url.searchParams.get("path") ?? "src/app.ts",
        available: true,
        status: "modified",
        revision,
        binary: false,
        content: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,2 +1,2 @@",
          '-export const theme = "classic"',
          '+export const theme = "workbench"',
          " export const density = 2",
          "",
        ].join("\n"),
        hunks: [{
          id: hunkId,
          header: "@@ -1,2 +1,2 @@",
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          content: [
            "@@ -1,2 +1,2 @@",
            '-export const theme = "classic"',
            '+export const theme = "workbench"',
            " export const density = 2",
            "",
          ].join("\n"),
        }],
        truncated: false,
      })
      return
    }
    if (url.pathname.endsWith("/changes")) {
      await fulfill(route, {
        available: true,
        sessionId,
        projectId: "project_default",
        projectRoot: "/workspace/pixiu-demo",
        createdAt: "2026-07-28T08:00:00.000Z",
        baseRevision: "0".repeat(64),
        workRevision: revision,
        revision,
        changes: [
          {
            path: "src/app.ts",
            status: "modified",
            binary: false,
            size: 63,
            hunkCount: 1,
            additions: 1,
            deletions: 1,
            appliedHunkIds: [],
            applied: false,
            staged: false,
            committed: false,
          },
        ],
        canUndo: false,
      })
      return
    }
    await route.continue()
  })
  await page.route("**/api/workspace**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/workspace/diff") {
      await fulfill(route, {
        path: url.searchParams.get("path") ?? "src/app.ts",
        available: true,
        truncated: false,
        status: "modified",
        branch: "ui-refresh",
        content: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,2 +1,2 @@",
          '-export const theme = "classic"',
          '+export const theme = "workbench"',
          " export const density = 2",
          "",
        ].join("\n"),
      })
      return
    }
    if (url.pathname === "/api/workspace/content") {
      const content = 'export const theme = "workbench"\nexport const density = 2\n'
      await fulfill(route, {
        path: url.searchParams.get("path") ?? "src/app.ts",
        size: content.length,
        updatedAt: "2026-07-28T08:00:00.000Z",
        content,
      })
      return
    }
    if (url.pathname === "/api/workspace") {
      await fulfill(route, {
        available: true,
        projectId: "project_default",
        projectName: "Pixiu visual fixture",
        rootPath: "/workspace/pixiu-demo",
        truncated: false,
        entries: [
          { path: "README.md", name: "README.md", parentPath: ".", type: "file", size: 84, updatedAt: "2026-07-28T08:00:00.000Z", kind: "text" },
          { path: "src", name: "src", parentPath: ".", type: "directory" },
          { path: "src/app.ts", name: "app.ts", parentPath: "src", type: "file", size: 63, updatedAt: "2026-07-28T08:00:00.000Z", kind: "text", gitStatus: "modified" },
          { path: "notes.md", name: "notes.md", parentPath: ".", type: "file", size: 28, updatedAt: "2026-07-28T08:00:00.000Z", kind: "text", gitStatus: "untracked" },
        ],
        git: {
          available: true,
          branch: "ui-refresh",
          changedFiles: [
            { path: "src/app.ts", status: "modified", indexStatus: " ", workingTreeStatus: "M" },
            { path: "notes.md", status: "untracked", indexStatus: "?", workingTreeStatus: "?" },
          ],
        },
      })
      return
    }
    await route.continue()
  })
}

async function fulfill(route: Route, data: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  })
}

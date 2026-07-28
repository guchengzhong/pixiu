import type { Page } from "@playwright/test"

import { test, expect } from "./fixtures"

test.describe("Pixiu UI shell", () => {
  test("loads without horizontal overflow and matches the viewport snapshot", async ({ page, openPixiu }) => {
    await openPixiu()

    await expect(page).toHaveTitle("Pixiu")
    await expect(page.locator("body")).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await expect(page).toHaveScreenshot("pixiu-shell.png", {
      fullPage: true,
      mask: [page.getByText(/\/tmp\/pixiu-e2e-[^/]*\/project/)],
      maskColor: "#ececec",
    })
  })

  test("exposes a keyboard reachable composer and navigation control", async ({ page, openPixiu }, testInfo) => {
    await openPixiu()
    const composer = page.getByRole("textbox").last()

    if (usesDrawerNavigation(testInfo.project.name)) {
      const openNavigation = page.getByRole("button", { name: "Open navigation" })
      await openNavigation.focus()
      await expect(openNavigation).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(page.locator(".workbench-sidebar.mobile-open")).toBeVisible()
      await page.locator(".mobile-nav-backdrop").click()
    } else {
      const collapseNavigation = page.getByRole("button", { name: "Collapse sidebar" })
      await collapseNavigation.focus()
      await expect(collapseNavigation).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
    }

    await composer.focus()
    await expect(composer).toBeFocused()
    await page.keyboard.press("Tab")

    const focused = page.locator(":focus")
    await expect(focused).toBeVisible()
    await expect(focused).toHaveJSProperty("disabled", false)
    expect(await focused.evaluate((element) => ["BUTTON", "INPUT", "SELECT", "A"].includes(element.tagName))).toBe(true)
  })

  test("mobile navigation and inspector trap focus, close with Escape, and restore their triggers", async ({ page, openPixiu }, testInfo) => {
    test.skip(!usesDrawerNavigation(testInfo.project.name), "Mobile drawer behavior only applies through the 1050px breakpoint")
    await openPixiu()

    const navigationTrigger = page.locator("#pixiu-navigation-trigger")
    const navigation = page.locator("#pixiu-navigation")
    await expect(navigationTrigger).toHaveAttribute("aria-controls", "pixiu-navigation")
    await expect(navigationTrigger).toHaveAttribute("aria-expanded", "false")
    await navigationTrigger.click()
    await expect(navigationTrigger).toHaveAttribute("aria-expanded", "true")
    await expect(navigation).toHaveAttribute("role", "dialog")
    await expect(navigation).toHaveAttribute("aria-modal", "true")

    const closeNavigation = navigation.getByRole("button", { name: "Close navigation" })
    const settings = navigation.getByRole("button", { name: "Settings", exact: true })
    await expect(closeNavigation).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(settings).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(closeNavigation).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(navigation).toBeHidden()
    await expect(navigationTrigger).toBeFocused()

    const inspectorTrigger = page.locator("#pixiu-inspector-trigger")
    const inspector = page.locator("#pixiu-inspector")
    await expect(inspectorTrigger).toHaveAttribute("aria-controls", "pixiu-inspector")
    await inspectorTrigger.click()
    await expect(inspector).toHaveAttribute("role", "dialog")
    await expect(inspector).toHaveAttribute("aria-modal", "true")

    const closeInspector = inspector.getByRole("button", { name: "Close inspector" })
    const activityTab = inspector.getByRole("tab", { name: "Activity" })
    await expect(closeInspector).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(activityTab).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(closeInspector).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(inspector).toBeHidden()
    await expect(inspectorTrigger).toBeFocused()
  })

  test("desktop inspector remains a non-modal complementary panel without a focus trap", async ({ page, openPixiu }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Desktop-only inspector behavior")
    await openPixiu()

    const inspectorTrigger = page.locator("#pixiu-inspector-trigger")
    const inspector = page.locator("#pixiu-inspector")
    await inspectorTrigger.click()
    await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible()
    await expect(inspector).not.toHaveAttribute("role", "dialog")
    await expect(inspector).not.toHaveAttribute("aria-modal", "true")

    const resizeHandle = inspector.getByRole("separator", { name: "Resize inspector" })
    await resizeHandle.focus()
    await page.keyboard.press("Escape")
    await expect(inspector).toBeVisible()
    await page.keyboard.press("Shift+Tab")
    await expect(inspector.locator(":focus")).toHaveCount(0)
  })
})

test.describe("session isolation", () => {
  test("switching sessions restores only the selected conversation", async ({ page, openPixiu, uiApi }) => {
    const alpha = await uiApi.seedSession("Alpha fixture", "alpha isolated prompt")
    const beta = await uiApi.seedSession("Beta fixture", "beta isolated prompt")
    await openPixiu()

    await selectSession(page, "Alpha fixture")
    await expect(page.getByText(alpha.prompt, { exact: true })).toBeVisible()
    await expect(page.getByText(alpha.answer, { exact: true })).toBeVisible()
    await expect(page.getByText(beta.prompt, { exact: true })).toHaveCount(0)

    await selectSession(page, "Beta fixture")
    await expect(page.getByText(beta.prompt, { exact: true })).toBeVisible()
    await expect(page.getByText(beta.answer, { exact: true })).toBeVisible()
    await expect(page.getByText(alpha.prompt, { exact: true })).toHaveCount(0)
  })

  test("clears the previous conversation while the selected session loads", async ({ page, openPixiu, uiApi }) => {
    const alpha = await uiApi.seedSession("Loading Alpha fixture", "loading alpha prompt")
    const beta = await uiApi.seedSession("Loading Beta fixture", "loading beta prompt")
    await openPixiu()
    await selectSession(page, alpha.title)
    await expect(page.getByText(alpha.prompt, { exact: true })).toBeVisible()

    let releaseRequest = () => {}
    let markRequestStarted = () => {}
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve })
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve })
    await page.route(`**/api/sessions/${encodeURIComponent(beta.id)}`, async (route) => {
      markRequestStarted()
      await requestGate
      await route.fulfill({ response: await route.fetch() })
    })

    try {
      await selectSession(page, beta.title)
      await requestStarted
      await expect(page.getByText(alpha.prompt, { exact: true })).toHaveCount(0)
      await expect(page.getByText(alpha.answer, { exact: true })).toHaveCount(0)
      await expect(page.getByText("Loading chat", { exact: true })).toBeVisible()

      releaseRequest()
      await expect(page.getByText(beta.prompt, { exact: true })).toBeVisible()
      await expect(page.getByText(beta.answer, { exact: true })).toBeVisible()
    } finally {
      releaseRequest()
      await page.unroute(`**/api/sessions/${encodeURIComponent(beta.id)}`)
    }
  })

  test("does not attach an upload response to a newly selected session", async ({ page, openPixiu, uiApi }) => {
    const alpha = await uiApi.seedSession("Upload Alpha fixture", "upload alpha prompt")
    const beta = await uiApi.seedSession("Upload Beta fixture", "upload beta prompt")
    await openPixiu()
    await selectSession(page, alpha.title)

    let releaseUpload = () => {}
    let markUploadStarted = () => {}
    let markUploadFinished = () => {}
    const uploadStarted = new Promise<void>((resolve) => { markUploadStarted = resolve })
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve })
    const uploadFinished = new Promise<void>((resolve) => { markUploadFinished = resolve })
    await page.route(`**/api/sessions/${encodeURIComponent(alpha.id)}/uploads*`, async (route) => {
      markUploadStarted()
      const response = await route.fetch()
      await uploadGate
      await route.fulfill({ response })
      markUploadFinished()
    })

    try {
      await page.locator('input[type="file"]').setInputFiles({
        name: "session-a-only.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("belongs to alpha"),
      })
      await uploadStarted
      await selectSession(page, beta.title)
      await expect(page.getByText(beta.prompt, { exact: true })).toBeVisible()
      releaseUpload()
      await uploadFinished

      await expect(page.getByText("session-a-only.txt", { exact: true })).toHaveCount(0)
      await expect(page.locator(".composer-attachments")).toHaveCount(0)
      await expect(page.getByText(alpha.prompt, { exact: true })).toHaveCount(0)
    } finally {
      releaseUpload()
      await page.unroute(`**/api/sessions/${encodeURIComponent(alpha.id)}/uploads*`)
    }
  })

  test("does not render an in-flight result in a different session", async ({ page, openPixiu, uiApi }) => {
    const alphaId = await uiApi.createSession("Slow Alpha fixture")
    const beta = await uiApi.seedSession("Stable Beta fixture", "stable beta prompt")
    const alphaPrompt = "slow session fixture alpha"
    const alphaAnswer = `E2E response: ${alphaPrompt}`
    await openPixiu()

    await selectSession(page, "Slow Alpha fixture")
    await page.getByRole("textbox").last().fill(alphaPrompt)
    await page.getByRole("button", { name: "Send message", exact: true }).click()
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible()

    await selectSession(page, "Stable Beta fixture")
    await expect(page.getByText(beta.prompt, { exact: true })).toBeVisible()
    await expect.poll(() => uiApi.sessionText(alphaId)).toContain(alphaAnswer)
    await expect(page.getByText(alphaPrompt, { exact: true })).toHaveCount(0)
    await expect(page.getByText(alphaAnswer, { exact: true })).toHaveCount(0)

    await selectSession(page, "Slow Alpha fixture")
    await expect(page.getByText(alphaPrompt, { exact: true })).toBeVisible()
    await expect(page.getByText(alphaAnswer, { exact: true })).toBeVisible()
  })

  test("restores active run controls after switching away and back", async ({ page, openPixiu, uiApi }) => {
    await uiApi.createSession("Active Alpha fixture")
    const beta = await uiApi.seedSession("Active run neighbor fixture", "stable active run neighbor prompt")
    await openPixiu()

    await selectSession(page, "Active Alpha fixture")
    await page.getByRole("textbox").last().fill("slow round trip fixture alpha")
    await page.getByRole("button", { name: "Send message", exact: true }).click()
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible()

    await selectSession(page, "Active run neighbor fixture")
    await expect(page.getByText(beta.prompt, { exact: true })).toBeVisible()

    await selectSession(page, "Active Alpha fixture")
    const stop = page.getByRole("button", { name: "Stop run" })
    await expect(stop).toBeVisible()
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0)
    await stop.click()
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible()
  })

  test("recovers a background run after its event stream reconnects", async ({ page, openPixiu, uiApi }) => {
    const alphaId = await uiApi.createSession("Disconnected Alpha fixture")
    const beta = await uiApi.seedSession("Disconnect neighbor fixture", "stable disconnect neighbor prompt")
    await openPixiu()

    let releaseRoute!: () => void
    let markRouteStarted!: () => void
    let markRouteAborted!: () => void
    const routeStarted = new Promise<void>((resolve) => { markRouteStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseRoute = resolve })
    const routeAborted = new Promise<void>((resolve) => { markRouteAborted = resolve })
    let interrupted = false
    await page.route("**/api/runs/*/events*", async (route) => {
      if (interrupted) {
        await route.continue()
        return
      }
      interrupted = true
      markRouteStarted()
      await release
      await route.abort("connectionfailed")
      markRouteAborted()
    })

    try {
      await selectSession(page, "Disconnected Alpha fixture")
      await page.getByRole("textbox").last().fill("slow session fixture disconnect")
      await page.getByRole("button", { name: "Send message", exact: true }).click()
      await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible()
      await routeStarted

      await selectSession(page, "Disconnect neighbor fixture")
      await expect(page.getByText(beta.prompt, { exact: true })).toBeVisible()
      releaseRoute()
      await routeAborted

      await selectSession(page, "Disconnected Alpha fixture")
      await expect.poll(() => uiApi.sessionText(alphaId)).toContain("E2E response: slow session fixture disconnect")
      await expect(page.getByText("slow session fixture disconnect", { exact: true })).toHaveCount(1)
      await expect(page.getByText("E2E response: slow session fixture disconnect", { exact: true })).toHaveCount(1)
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(0)
    } finally {
      releaseRoute()
      await page.unroute("**/api/runs/*/events*")
    }
  })
})

test.describe("turn recovery actions", () => {
  test("adds whole-file and line-range references from the workspace tree", async ({ page, openPixiu, uiApi }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Workspace reference semantics only need one browser viewport")
    await uiApi.createSession("Workspace reference fixture")
    await openPixiu()
    await selectSession(page, "Workspace reference fixture")

    await page.getByRole("button", { name: "Open inspector" }).click()
    const inspector = page.locator("#pixiu-inspector")
    await inspector.getByRole("tab", { name: "Files" }).click()
    await inspector.locator('.workspace-tree-entry[title="reference-fixture.ts"]').click()

    await inspector.getByRole("button", { name: "Add to prompt", exact: true }).click()
    const references = page.locator(".composer-attachments .attachment-name")
    await expect(references).toHaveText(["@reference-fixture.ts"])

    const range = inspector.getByLabel("Add line range to prompt")
    await range.getByRole("spinbutton", { name: "Start" }).fill("1")
    await range.getByRole("spinbutton", { name: "End" }).fill("2")
    await range.getByRole("button", { name: "Add range" }).click()
    await expect(references).toHaveText(["@reference-fixture.ts", "@reference-fixture.ts:1-2"])

    await page.getByRole("button", { name: "Remove reference-fixture.ts from this message" }).first().click()
    await expect(references).toHaveText(["@reference-fixture.ts:1-2"])
    await page.getByRole("button", { name: "Remove reference-fixture.ts from this message" }).click()
    await expect(references).toHaveCount(0)
  })

  test("restores edited prompt references and preserves retry model semantics", async ({ page, openPixiu, uiApi }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Turn action semantics only need one browser viewport")
    const seeded = await uiApi.seedSession("Turn recovery fixture", "explain the selected fixture lines", [{
      path: "reference-fixture.ts",
      source: "workspace",
      startLine: 1,
      endLine: 2,
    }])
    await openPixiu()
    await selectSession(page, seeded.title)

    await page.getByRole("button", { name: "Edit & resend" }).click()
    const composer = page.getByRole("textbox", { name: "Message Pixiu" })
    await expect(composer).toHaveValue(seeded.prompt)
    const reference = page.locator(".composer-attachments .attachment-name")
    await expect(reference).toHaveText("@reference-fixture.ts:1-2")
    await page.getByRole("button", { name: "Remove reference-fixture.ts from this message" }).click()
    await expect(reference).toHaveCount(0)

    const originalAssistant = page.locator("article.message.assistant").last()
    const currentRetryRequest = page.waitForRequest(isRunRequest)
    await originalAssistant.getByRole("button", { name: "Retry", exact: true }).click()
    const currentRetry = await currentRetryRequest
    expect(currentRetry.postDataJSON()).toMatchObject({
      message: seeded.prompt,
      model: seeded.model,
      retryOf: seeded.turnId,
      references: [{ path: "reference-fixture.ts", source: "workspace", startLine: 1, endLine: 2 }],
    })
    await expect(page.locator(".turn-metrics")).toHaveCount(2)
    await expect(page.locator(".turn-metrics").last()).toContainText("retry 1")

    const alternateRetryRequest = page.waitForRequest(isRunRequest)
    await page.locator("article.message.assistant").last().getByRole("button", { name: "Retry with another model" }).click()
    const alternateRetry = await alternateRetryRequest
    const alternateBody = alternateRetry.postDataJSON() as { model?: string; retryOf?: string }
    expect(alternateBody.model).toBe("deepseek-ai/DeepSeek-V3.2")
    expect(alternateBody.model).not.toBe(seeded.model)
    expect(alternateBody.retryOf).not.toBe(seeded.turnId)
    await expect(page.locator(".turn-metrics")).toHaveCount(3)
    await expect(page.locator(".turn-metrics").last()).toContainText("deepseek-ai/DeepSeek-V3.2")
    await expect(page.locator(".turn-metrics").last()).toContainText("retry 2")

    const alternateCurrentRetryRequest = page.waitForRequest(isRunRequest)
    await page.locator("article.message.assistant").last().getByRole("button", { name: "Retry", exact: true }).click()
    const alternateCurrentRetry = await alternateCurrentRetryRequest
    const alternateCurrentBody = alternateCurrentRetry.postDataJSON() as { model?: string }
    expect(alternateCurrentBody.model).toBe("deepseek-ai/DeepSeek-V3.2")
    await expect(page.locator(".turn-metrics")).toHaveCount(4)
    await expect(page.locator(".turn-metrics").last()).toContainText("retry 3")
  })
})

test.describe("permission recovery", () => {
  test("restores a pending permission after switching away and back", async ({ page, openPixiu, uiApi }) => {
    await uiApi.createSession("Pending permission fixture")
    const neighbor = await uiApi.seedSession("Permission neighbor fixture", "stable permission neighbor prompt")
    await openPixiu()

    await selectSession(page, "Pending permission fixture")
    await page.getByRole("combobox", { name: "Permission mode" }).selectOption("default")
    await page.getByRole("textbox").last().fill("Run the permission fixture across sessions")
    await page.getByRole("button", { name: "Send message", exact: true }).click()

    const prompt = page.getByText("Permission required", { exact: true })
    await expect(prompt).toBeVisible()

    await selectSession(page, "Permission neighbor fixture", true)
    await expect(prompt).toHaveCount(0)
    await expect(page.getByText(neighbor.prompt, { exact: true })).toBeVisible()

    await selectSession(page, "Pending permission fixture")
    await expect(prompt).toBeVisible()
    await page.getByRole("button", { name: "Allow once" }).click()

    await expect(prompt).toHaveCount(0)
    await expect(page.getByText("Permission fixture completed.", { exact: false })).toBeVisible()
  })

  test("keeps the permission prompt recoverable when the response request fails", async ({ page, openPixiu, uiApi }) => {
    await uiApi.createSession("Permission fixture")
    await openPixiu()
    await selectSession(page, "Permission fixture")
    await page.getByRole("combobox", { name: "Permission mode" }).selectOption("default")
    await page.getByRole("textbox").last().fill("Run the permission fixture")
    await page.getByRole("button", { name: "Send message", exact: true }).click()

    const prompt = page.getByText("Permission required", { exact: true })
    await expect(prompt).toBeVisible()

    let permissionId = ""
    let releasePermissionResponse = () => {}
    const permissionResponseGate = new Promise<void>((resolve) => {
      releasePermissionResponse = resolve
    })
    await page.route("**/api/permissions/*", async (route) => {
      permissionId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "")
      await permissionResponseGate
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "E2E_PERMISSION_FAILURE", message: "Permission response failed in fixture." }),
      })
    })

    try {
      await page.getByRole("button", { name: "Allow once" }).click()
      const dialog = page.getByRole("dialog", { name: "Permission required" })
      await expect(dialog).toBeFocused()
      await expect(dialog.getByRole("button", { name: "Deny" })).toBeDisabled()
      await expect(dialog.getByRole("button", { name: "Allow similar" })).toBeDisabled()
      await expect(dialog.getByRole("button", { name: "Applying..." })).toBeDisabled()
      await page.keyboard.press("Tab")
      await expect(dialog).toBeFocused()
      releasePermissionResponse()
      await expect(prompt).toBeVisible()
      await expect(page.getByText("Permission response failed in fixture.", { exact: false })).toBeVisible()
      expect(permissionId).not.toBe("")
    } finally {
      releasePermissionResponse()
      await page.unroute("**/api/permissions/*")
      if (permissionId) await uiApi.answerPermission(permissionId).catch(() => undefined)
    }
    await expect(prompt).toHaveCount(0)
  })

  test("keeps a newer permission visible when the previous response finishes late", async ({ page, openPixiu, uiApi }) => {
    await uiApi.createSession("Double permission fixture")
    await openPixiu()
    await selectSession(page, "Double permission fixture")
    await page.getByRole("combobox", { name: "Permission mode" }).selectOption("default")
    await page.getByRole("textbox").last().fill("Run the double permission fixture")
    await page.getByRole("button", { name: "Send message", exact: true }).click()

    let releaseFirstResponse = () => {}
    let markServerAnswered = () => {}
    const firstResponseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve })
    const serverAnswered = new Promise<void>((resolve) => { markServerAnswered = resolve })
    let permissionRequestCount = 0
    const permissionIds = new Set<string>()
    await page.route("**/api/permissions/*", async (route) => {
      const permissionId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "")
      if (permissionId) permissionIds.add(permissionId)
      permissionRequestCount += 1
      if (permissionRequestCount > 1) {
        await route.continue()
        return
      }
      await route.fetch()
      markServerAnswered()
      await firstResponseGate
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "E2E_LATE_PERMISSION_RESPONSE", message: "The first permission response arrived late." }),
      })
    })

    try {
      const dialog = page.getByRole("dialog", { name: "Permission required" })
      await expect(dialog).toContainText("permission-fixture-1.txt")
      await dialog.getByRole("button", { name: "Allow once" }).click()
      await serverAnswered
      await expect(dialog).toContainText("permission-fixture-2.txt")

      releaseFirstResponse()
      await expect(dialog).toContainText("permission-fixture-2.txt")
      await expect(dialog).not.toContainText("first permission response arrived late")
      await dialog.getByRole("button", { name: "Allow once" }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByText("Permission fixture completed.", { exact: false })).toBeVisible()
    } finally {
      releaseFirstResponse()
      await page.unroute("**/api/permissions/*")
      await Promise.all([...permissionIds].map((id) => uiApi.answerPermission(id).catch(() => undefined)))
    }
  })
})

async function selectSession(page: Page, title: string, behindModal = false) {
  const session = page.getByRole("button", { name: new RegExp(title) })
  if (!(await session.isVisible())) {
    const openNavigation = page.getByRole("button", { name: "Open navigation" })
    if (behindModal) await openNavigation.dispatchEvent("click")
    else await openNavigation.click()
    await expect(page.locator(".workbench-sidebar.mobile-open")).toBeVisible()
  }
  if (behindModal) await session.dispatchEvent("click")
  else await session.click()
}

function usesDrawerNavigation(projectName: string) {
  return projectName === "tablet-1024" || projectName === "mobile-390"
}

function isRunRequest(request: { method(): string; url(): string }) {
  return request.method() === "POST" && new URL(request.url()).pathname === "/api/runs"
}

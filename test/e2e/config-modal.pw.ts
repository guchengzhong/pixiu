import { test, expect } from "./fixtures"

test("first launch requires project selection and a successful provider connection test", async ({ page, openPixiu }) => {
  await page.route("**/api/status*", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.provider.keyPresent = false
    await route.fulfill({ response, json: body })
  })
  await page.route("**/api/config/provider", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { provider: { model: "openai-compatible/e2e-model", credential: "apiKey", keyPresent: true } } }),
    })
  })
  await page.route("**/api/config/test-provider", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { ok: true, model: "openai-compatible/e2e-model", text: "connected" } }),
    })
  })

  await openPixiu()
  const dialog = page.getByRole("dialog", { name: "Set up Pixiu" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("combobox", { name: "Project workspace" })).not.toHaveValue("")
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()

  await dialog.getByRole("button", { name: "Save and test connection" }).click()
  await expect(dialog).toHaveCount(0)
})

test("provider configuration traps focus and closes with Escape", async ({ page, openPixiu }, testInfo) => {
  await openPixiu()

  const sidebar = page.locator(".workbench-sidebar")
  if (testInfo.project.name === "tablet-1024" || testInfo.project.name === "mobile-390") {
    await page.getByRole("button", { name: "Open navigation" }).click()
    await expect(sidebar).toHaveClass(/mobile-open/)
  }
  const settings = sidebar.getByRole("button", { name: "Settings", exact: true })
  await settings.scrollIntoViewIfNeeded()
  await settings.click()

  const dialog = page.getByRole("dialog", { name: "Provider configuration" })
  const endpoint = dialog.getByRole("combobox", { name: "Endpoint" })
  const close = dialog.getByRole("button", { name: "Close" })
  const save = dialog.getByRole("button", { name: "Save provider" })

  await expect(dialog).toBeVisible()
  await expect(endpoint).toBeFocused()

  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(save).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

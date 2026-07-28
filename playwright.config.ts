import { defineConfig } from "@playwright/test"

export const E2E_HOST = "127.0.0.1"
export const E2E_PORT = Number.parseInt(process.env.PIXIU_E2E_PORT ?? "3219", 10)
export const E2E_LLM_PORT = Number.parseInt(process.env.PIXIU_E2E_LLM_PORT ?? "3220", 10)
export const E2E_TOKEN = "pixiu-e2e-token"
export const E2E_BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`
const chromiumExecutable = process.env.PIXIU_E2E_CHROMIUM_PATH

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.pw.ts",
  snapshotPathTemplate: "{testDir}/ui.spec.ts-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}",
  outputDir: "/tmp/pixiu-playwright-results",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.005,
    },
  },
  reporter: process.env.CI ? [["line"], ["html", { open: "never", outputFolder: "/tmp/pixiu-playwright-report" }]] : "line",
  use: {
    baseURL: E2E_BASE_URL,
    colorScheme: "light",
    locale: "en-US",
    ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "tablet-1024",
      use: { browserName: "chromium", viewport: { width: 1024, height: 768 } },
    },
    {
      name: "mobile-390",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: "bun run test/e2e/server.ts",
    url: `${E2E_BASE_URL}/api/status?token=${E2E_TOKEN}`,
    timeout: 30_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
})

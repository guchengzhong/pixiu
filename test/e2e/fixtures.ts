import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test"

import { E2E_TOKEN } from "../../playwright.config"

type SessionSeed = {
  id: string
  title: string
  prompt: string
  answer: string
  turnId: string
  model: string
}

type SessionReference = {
  path: string
  source: "uploaded" | "workspace" | "generated" | "evidence"
  startLine?: number
  endLine?: number
}

type UiApiFixture = {
  createSession(title: string): Promise<string>
  seedSession(title: string, prompt: string, references?: SessionReference[]): Promise<SessionSeed>
  sessionText(id: string): Promise<string>
  deleteSession(id: string): Promise<void>
  answerPermission(id: string, action?: "allow" | "deny"): Promise<void>
}

type Fixtures = {
  openPixiu(page?: Page): Promise<void>
  uiApi: UiApiFixture
}

export const test = base.extend<Fixtures>({
  openPixiu: async ({ page }, use) => {
    await use(async (target = page) => {
      const pageErrors: string[] = []
      target.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
      await target.goto(`/?token=${E2E_TOKEN}`)
      await target.waitForLoadState("networkidle")
      try {
        await expect(target.locator("#root")).not.toBeEmpty()
      } catch (error) {
        if (pageErrors.length) throw new Error(`Pixiu failed during browser startup:\n${pageErrors.join("\n\n")}`, { cause: error })
        throw error
      }
      await expect(target.getByRole("textbox").last()).toBeVisible()
    })
  },

  uiApi: async ({ request }, use) => {
    const created = new Set<string>()
    const api = createUiApi(request, created)
    await use(api)
    await Promise.all([...created].map((id) => api.deleteSession(id).catch(() => undefined)))
  },
})

export { expect }

function createUiApi(request: APIRequestContext, created: Set<string>): UiApiFixture {
  const headers = { authorization: `Bearer ${E2E_TOKEN}`, "content-type": "application/json" }
  const createSession = async (title: string) => {
    const response = await request.post("/api/sessions", { headers, data: { title } })
    if (!response.ok()) throw new Error(`Session fixture creation failed (${response.status()}): ${await response.text()}`)
    const body = await response.json() as { data: { session: { id: string } } }
    created.add(body.data.session.id)
    return body.data.session.id
  }

  return {
    createSession,

    async seedSession(title, prompt, references = []) {
      const id = await createSession(title)
      const response = await request.post("/api/runs?wait=1", {
        headers,
        data: { message: prompt, sessionId: id, permissionMode: "bypassPermissions", references },
        timeout: 15_000,
      })
      if (!response.ok()) throw new Error(`Session fixture run failed (${response.status()}): ${await response.text()}`)
      const body = await response.json() as { data: { answer: string; status: string; turnId: string; model: string } }
      expect(body.data.status).toBe("idle")
      return { id, title, prompt, answer: body.data.answer, turnId: body.data.turnId, model: body.data.model }
    },

    async deleteSession(id) {
      const response = await request.delete(`/api/sessions/${encodeURIComponent(id)}`, { headers })
      if (!response.ok() && response.status() !== 404) throw new Error(await response.text())
      created.delete(id)
    },

    async sessionText(id) {
      const response = await request.get(`/api/sessions/${encodeURIComponent(id)}`, { headers })
      if (!response.ok()) throw new Error(`Session fixture read failed (${response.status()}): ${await response.text()}`)
      const body = await response.json() as { data: { messages: unknown[] } }
      return JSON.stringify(body.data.messages)
    },

    async answerPermission(id, action = "deny") {
      const response = await request.post(`/api/permissions/${encodeURIComponent(id)}`, {
        headers,
        data: { action, scope: "once" },
      })
      if (!response.ok()) throw new Error(`Permission fixture cleanup failed (${response.status()}): ${await response.text()}`)
    },
  }
}

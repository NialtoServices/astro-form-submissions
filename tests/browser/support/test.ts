import { randomUUID } from 'node:crypto'
import { test as base, expect } from '@playwright/test'
import { FIXTURE_ORIGIN, RUN_COOKIE_NAME, type RecordedEmail } from '../fixture/shared.ts'

interface BrowserFixtures {
  /** Reads back the emails this test's submissions sent, in the order they went. */
  deliveries: () => Promise<RecordedEmail[]>
}

/**
 * Playwright's `test`, with each test's browser context tagged by a run cookie of its own, so the emails a test
 * reads back are only those its own submissions sent, however many tests share the fixture server at once.
 */
export const test = base.extend<BrowserFixtures>({
  context: async ({ context }, use) => {
    await context.addCookies([{ name: RUN_COOKIE_NAME, value: randomUUID(), url: FIXTURE_ORIGIN }])
    await use(context)
  },

  deliveries: async ({ context }, use) => {
    await use(async () => {
      const response = await context.request.get(`${FIXTURE_ORIGIN}/__deliveries`)
      expect(response.ok()).toBe(true)
      return (await response.json()) as RecordedEmail[]
    })
  }
})

export { expect }

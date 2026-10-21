import type { Page } from '@playwright/test'
import { expect, test } from './support/test.ts'

const TURNSTILE_PAGE_PATH = '/turnstile.html'
const STATE_ATTRIBUTE = 'data-astro-form-turnstile'

type TurnstileFakeWindow = { __turnstileFake: { challenge(): void; settle(): void } }

/** Make the fake widget show a challenge, or finish one. */
function driveWidget(page: Page, action: 'challenge' | 'settle') {
  return page.evaluate((name) => (window as unknown as TurnstileFakeWindow).__turnstileFake[name](), action)
}

test('a form without a widget carries no Turnstile state', async ({ page }) => {
  await page.goto(TURNSTILE_PAGE_PATH)

  await expect(page.locator('#no-widget').locator('.cf-turnstile')).toHaveCount(0)
  await expect(page.locator('#no-widget [data-astro-form-turnstile]')).toHaveCount(0)
})

test('an interaction-only widget is invisible until it shows a challenge, and invisible again once settled', async ({
  page
}) => {
  await page.goto(TURNSTILE_PAGE_PATH)
  const container = page.locator('#interaction-only .cf-turnstile')

  await expect(container.locator('iframe')).toHaveCount(1)
  await expect(container).toHaveAttribute(STATE_ATTRIBUTE, 'invisible')

  await driveWidget(page, 'challenge')
  await expect(container).toHaveAttribute(STATE_ATTRIBUTE, 'visible')

  await driveWidget(page, 'settle')
  await expect(container).toHaveAttribute(STATE_ATTRIBUTE, 'invisible')
})

test('an always-shown widget is visible', async ({ page }) => {
  await page.goto(TURNSTILE_PAGE_PATH)

  const container = page.locator('#always-shown .cf-turnstile')
  await expect(container.locator('iframe')).toHaveCount(1)
  await expect(container).toHaveAttribute(STATE_ATTRIBUTE, 'visible')
})

test('a site can collapse the space around an invisible widget', async ({ page }) => {
  await page.goto(TURNSTILE_PAGE_PATH)
  await page.addStyleTag({
    content: `.cf-turnstile { margin-block: 40px } .cf-turnstile[${STATE_ATTRIBUTE}='invisible'] { margin-block: 0 }`
  })
  const container = page.locator('#interaction-only .cf-turnstile')
  const marginTop = () => container.evaluate((element) => getComputedStyle(element).marginTop)

  await expect.poll(marginTop).toBe('0px')

  await driveWidget(page, 'challenge')
  await expect.poll(marginTop).toBe('40px')
})

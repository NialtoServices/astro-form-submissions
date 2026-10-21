import type { Page } from '@playwright/test'
import { expect, test } from './support/test.ts'

const DIRECT_UPLOAD_PAGE_PATH = '/direct-upload.html'

const SUCCESS_COPY = "Thanks, we'll be in touch."

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

/** A file of an exact size, large enough for the browser to report upload progress on loopback. */
function photoOf(name: string, byteLength: number) {
  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.concat([PNG_HEADER, Buffer.alloc(byteLength)])
  }
}

/** The numbers a progress element shows, as a person would read them off a bar. */
function barOf(progress: ReturnType<Page['locator']>) {
  return progress.evaluate((element: HTMLProgressElement) => ({
    value: element.value,
    max: element.max,
    state: element.getAttribute('data-astro-form-file-state')
  }))
}

test("each file's progress slot and the field's progress move while uploading and finish done", async ({ page }) => {
  await page.goto(DIRECT_UPLOAD_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page
    .getByLabel('Photos', { exact: true })
    .setInputFiles([photoOf('garden.png', 200_000), photoOf('loft.png', 200_000)])

  // The form's own post is held, so the finished upload can be looked at before the success reset clears it.
  let releaseSubmission: () => void = () => {}
  const submissionHeld = new Promise<void>((resolve) => (releaseSubmission = resolve))
  await page.route('**/api/photos', async (route) => {
    await submissionHeld
    await route.continue()
  })

  const fieldBar = page.getByRole('progressbar', { name: 'Overall progress' })
  await fieldBar.evaluate((element: HTMLProgressElement) => {
    const seen: number[] = []
    ;(window as unknown as { seenProgress: number[] }).seenProgress = seen
    new MutationObserver(() => seen.push(element.value)).observe(element, {
      attributes: true,
      attributeFilter: ['value']
    })
  })

  await page.getByRole('button', { name: 'Send' }).click()

  const itemBars = page.getByRole('list', { name: 'Chosen photos' }).getByRole('progressbar')
  await expect.poll(() => barOf(fieldBar)).toMatchObject({ state: 'done' })
  const field = await barOf(fieldBar)
  expect(field.value).toBe(field.max)
  expect(field.max).toBeGreaterThan(400_000)

  for (const index of [0, 1]) {
    const item = await barOf(itemBars.nth(index))
    expect(item).toMatchObject({ state: 'done' })
    expect(item.value).toBe(item.max)
  }

  await expect(page.locator('#photos-meter')).toHaveCSS('--astro-form-progress', '1')

  const seen = await page.evaluate(() => (window as unknown as { seenProgress: number[] }).seenProgress)
  expect(seen).toEqual([...seen].sort((first, second) => first - second))
  expect(seen.at(-1)).toBe(field.max)

  releaseSubmission()
  await expect(page.getByRole('status')).toHaveText(SUCCESS_COPY)
})

test('a refusal from the upload route lands on the direct-upload input', async ({ page, deliveries }) => {
  await page.goto(DIRECT_UPLOAD_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  const photosInput = page.getByLabel('Photos', { exact: true })
  await photosInput.setInputFiles([photoOf('huge.png', 300_000)])
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(photosInput).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#quote-photos-error')).toHaveText('Each file must be 256 KB or smaller.')
  await expect(photosInput).toBeFocused()
  expect((await barOf(page.getByRole('progressbar', { name: 'Overall progress' }))).value).toBe(0)
  expect(await deliveries()).toHaveLength(0)
})

test('a script-only field is revealed when the script runs', async ({ page }) => {
  await page.goto(DIRECT_UPLOAD_PAGE_PATH)

  await expect(page.getByRole('group', { name: 'Photos' })).toBeVisible()
  await expect(page.locator('noscript p')).toBeHidden()
})

test.describe(() => {
  test.use({ javaScriptEnabled: false })

  test('without JavaScript, a script-only field stays hidden and the rest of the form submits', async ({
    page,
    deliveries
  }) => {
    await page.goto(DIRECT_UPLOAD_PAGE_PATH)
    await expect(page.getByRole('group', { name: 'Photos' })).toBeHidden()
    await expect(page.locator('noscript p')).toHaveText('Photos can only be added with JavaScript turned on.')

    await page.getByLabel('Name').fill('Ada Lovelace')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.locator('body')).toHaveText('Form submitted. Please return to the home page.')
    await expect.poll(async () => (await deliveries()).length).toBe(1)
    expect((await deliveries())[0]?.text).toContain('Ada Lovelace')
  })
})

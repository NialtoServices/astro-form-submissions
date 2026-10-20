import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/test.ts'

const DROP_PAGE_PATH = '/file-drop.html'

interface DraggedFile {
  name: string
  type: string
  text: string
}

const PORCH = { name: 'porch.png', type: 'image/png', text: '\x89PNG\r\n\x1a\nporch' }
const GARDEN = { name: 'garden.png', type: 'image/png', text: '\x89PNG\r\n\x1a\ngarden' }
const SHED = { name: 'shed.jpg', type: 'image/jpeg', text: 'shed' }
const FLOOR_PLAN = { name: 'floor-plan.pdf', type: 'application/pdf', text: '%PDF-1.7\nfloor plan\n' }
const SECOND_PLAN = { name: 'second-plan.pdf', type: 'application/pdf', text: '%PDF-1.7\nsecond plan\n' }
const NOTES = { name: 'notes.txt', type: 'text/plain', text: 'Measurements\n' }

/**
 * Dispatch a drag event on `target` carrying `files` in a real `DataTransfer`, as a browser does for a file dragged
 * in from the desktop. Resolves whether the event went uncancelled, which is what lets the browser open a dropped
 * file.
 */
async function dragFiles(
  target: Locator,
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  files: DraggedFile[]
): Promise<boolean> {
  const dataTransfer = await target.page().evaluateHandle((draggedFiles) => {
    const transfer = new DataTransfer()
    for (const { name, type: fileType, text } of draggedFiles)
      transfer.items.add(new File([text], name, { type: fileType, lastModified: 1_700_000_000_000 }))
    return transfer
  }, files)

  return target.evaluate(
    (element, { dataTransfer: transfer, type: eventType }) =>
      element.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: transfer })),
    { dataTransfer, type }
  )
}

/** Drag something that is not a file, such as selected text, over `target` and drop it. */
async function dragText(target: Locator, type: 'dragover' | 'drop'): Promise<boolean> {
  return target.evaluate((element, eventType) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'Measurements')
    return element.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, type)
}

function photosZone(page: Page) {
  return page.getByText('Drop photos here')
}

function planZone(page: Page) {
  return page.getByText('Drop your plan here')
}

function listedItems(page: Page, listName: string) {
  return page.getByRole('list', { name: listName }).getByRole('listitem')
}

test('files dropped on the field join the selection', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)
  await page
    .getByLabel('Photos of the job')
    .setInputFiles([{ name: PORCH.name, mimeType: PORCH.type, buffer: Buffer.from(PORCH.text) }])

  await dragFiles(photosZone(page), 'drop', [GARDEN, SHED])
  await dragFiles(page.getByLabel('Photos of the job'), 'drop', [GARDEN])

  await expect(listedItems(page, 'Chosen photos')).toHaveText([/porch\.png/, /garden\.png/, /shed\.jpg/])
})

test('a dropped file is sent with the form', async ({ page, deliveries }) => {
  await page.goto(DROP_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await dragFiles(planZone(page), 'drop', [FLOOR_PLAN])
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByRole('status')).toHaveText("Thanks, we'll be in touch.")
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  const attachments = (await deliveries())[0]?.attachments ?? []
  expect(attachments.map((attachment) => attachment.filename)).toEqual(['floor-plan.pdf'])
  expect(Buffer.from(attachments[0]?.content ?? '', 'base64').toString('utf8')).toBe(FLOOR_PLAN.text)
})

test('a drop on a single-file field keeps the first and says only one is allowed', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)

  await dragFiles(planZone(page), 'drop', [FLOOR_PLAN, SECOND_PLAN])

  await expect(listedItems(page, 'Chosen plan')).toHaveText([/floor-plan\.pdf/])
  await expect(page.getByRole('status')).toHaveText('Only one file can be added.')
  await expect(page.getByLabel('Floor plan')).not.toHaveAttribute('aria-invalid')
  await expect(page.getByRole('status')).not.toHaveAttribute('data-astro-form-state')
})

test('two file fields each take only their own drops', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)

  await dragFiles(photosZone(page), 'drop', [PORCH])
  await dragFiles(planZone(page), 'drop', [FLOOR_PLAN])
  await dragFiles(page.getByLabel('Floor plan'), 'drop', [SECOND_PLAN])

  await expect(listedItems(page, 'Chosen photos')).toHaveText([/porch\.png/])
  await expect(listedItems(page, 'Chosen plan')).toHaveText([/second-plan\.pdf/])
})

test('a dropped file of the wrong type is listed and flagged', async ({ page }) => {
  const typeMessage = 'That file type is not accepted. Please attach PDF.'
  await page.goto(DROP_PAGE_PATH)

  await dragFiles(planZone(page), 'drop', [SHED])

  const item = listedItems(page, 'Chosen plan').filter({ hasText: 'shed.jpg' })
  await expect(item).toContainText(typeMessage)
  await expect(item).toHaveAttribute('data-astro-form-file-state', 'invalid')

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toHaveText(typeMessage)
  await expect(page.getByLabel('Floor plan')).toHaveAttribute('aria-invalid', 'true')
})

test('shows the hover state while a file is dragged over, and clears it on leaving and on dropping', async ({
  page
}) => {
  await page.goto(DROP_PAGE_PATH)
  const zone = photosZone(page)

  await expect(zone).not.toHaveAttribute('data-astro-form-file-drop')
  await dragFiles(zone, 'dragenter', [PORCH])
  await expect(zone).toHaveAttribute('data-astro-form-file-drop', 'active')
  await expect(planZone(page)).not.toHaveAttribute('data-astro-form-file-drop')

  await dragFiles(zone, 'dragleave', [PORCH])
  await expect(zone).not.toHaveAttribute('data-astro-form-file-drop')

  await dragFiles(zone, 'dragover', [PORCH])
  await expect(zone).toHaveAttribute('data-astro-form-file-drop', 'active')
  await dragFiles(zone, 'drop', [PORCH])
  await expect(zone).not.toHaveAttribute('data-astro-form-file-drop')
})

test('a disabled field ignores drops and shows no hover state', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)
  await page.locator('#plan-section').evaluate((fieldset: HTMLFieldSetElement) => (fieldset.disabled = true))
  const zone = planZone(page)

  const entered = await dragFiles(zone, 'dragenter', [FLOOR_PLAN])
  const dropped = await dragFiles(zone, 'drop', [FLOOR_PLAN])

  await expect(zone).not.toHaveAttribute('data-astro-form-file-drop')
  await expect(listedItems(page, 'Chosen plan')).toHaveCount(0)

  // A cancelled drop is one the browser doesn't act on by opening the file.
  expect([entered, dropped]).toEqual([false, false])
})

test("a missed drop doesn't open the file", async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)
  const urlBeforeDrop = page.url()
  const elsewhere = page.locator('#elsewhere')

  const over = await dragFiles(elsewhere, 'dragover', [PORCH])
  const dropped = await dragFiles(elsewhere, 'drop', [PORCH])

  expect([over, dropped]).toEqual([false, false])
  expect(page.url()).toBe(urlBeforeDrop)
  await expect(listedItems(page, 'Chosen photos')).toHaveCount(0)
  await expect(listedItems(page, 'Chosen plan')).toHaveCount(0)
})

test('a text drag outside any target is not blocked', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)

  const over = await dragText(page.getByLabel('Notes'), 'dragover')
  const dropped = await dragText(page.getByLabel('Notes'), 'drop')

  expect([over, dropped]).toEqual([true, true])
})

test('a drop zone without a list adds dropped files', async ({ page }) => {
  const typeMessage = 'That file type is not accepted. Please attach Text.'
  await page.goto(DROP_PAGE_PATH)
  const measurementsInput = page.getByLabel('Measurements file')
  const heldFiles = () =>
    measurementsInput.evaluate((input: HTMLInputElement) => Array.from(input.files ?? [], (file) => file.name))

  await dragFiles(page.getByText('Drop measurements here'), 'drop', [NOTES])
  await dragFiles(page.getByText('Drop measurements here'), 'drop', [SHED])

  await expect.poll(heldFiles).toEqual(['notes.txt', 'shed.jpg'])

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toHaveText(typeMessage)
  await expect(measurementsInput).toHaveAttribute('aria-invalid', 'true')
})

test('a drop on an input inside its drop zone announces a single file once', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)
  await page.getByLabel('Floor plan').evaluate((input) => {
    const zone = document.createElement('div')
    zone.setAttribute('data-astro-form-file-drop-for', 'cv')
    input.replaceWith(zone)
    zone.append(input)
    ;(window as unknown as { statusWrites: number }).statusWrites = 0
    new MutationObserver((records) => {
      ;(window as unknown as { statusWrites: number }).statusWrites += records.length
    }).observe(document.querySelector('[data-astro-form-status]') as Element, { childList: true })
  })

  await dragFiles(page.getByLabel('Floor plan'), 'drop', [FLOOR_PLAN, SECOND_PLAN])

  await expect(page.getByRole('status')).toHaveText('Only one file can be added.')
  await expect(listedItems(page, 'Chosen plan')).toHaveText([/floor-plan\.pdf/])
  expect(await page.evaluate(() => (window as unknown as { statusWrites: number }).statusWrites)).toBe(1)
})

test('the only-one-file notice goes once the next drop is accepted', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)

  await dragFiles(planZone(page), 'drop', [FLOOR_PLAN, SECOND_PLAN])
  await expect(page.getByRole('status')).toHaveText('Only one file can be added.')
  await dragFiles(planZone(page), 'drop', [FLOOR_PLAN])

  await expect(page.getByRole('status')).toHaveText('')
})

test('a disabled file input with no drop zone is guarded too', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)
  await page.evaluate(() => {
    const unlistedInput = document.createElement('input')
    unlistedInput.type = 'file'
    unlistedInput.disabled = true
    unlistedInput.setAttribute('aria-label', 'Disabled file')
    document.querySelector('main')?.append(unlistedInput)
  })

  const dropped = await dragFiles(page.getByLabel('Disabled file'), 'drop', [NOTES])

  expect(dropped).toBe(false)
})

test('a file dragged over a file input with no list is left to the browser', async ({ page }) => {
  await page.goto(DROP_PAGE_PATH)
  await page.evaluate(() => {
    const unlistedInput = document.createElement('input')
    unlistedInput.type = 'file'
    unlistedInput.name = 'notes'
    unlistedInput.setAttribute('aria-label', 'Unlisted file')
    document.querySelector('main')?.append(unlistedInput)
  })

  const dropped = await dragFiles(page.getByLabel('Unlisted file'), 'drop', [NOTES])

  expect(dropped).toBe(true)
})

import type { Page } from '@playwright/test'
import type { RecordedEmail } from './fixture/shared.ts'
import { expect, test } from './support/test.ts'

const FILES_PAGE_PATH = '/files.html'
const SINGLE_FILE_PAGE_PATH = '/single-file.html'
const TWO_FORMS_PAGE_PATH = '/two-forms.html'

const SUCCESS_COPY = "Thanks, we'll be in touch."

const CV = { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nAda Lovelace, analyst\n') }
const COVER_LETTER = { name: 'cover-letter.txt', mimeType: 'text/plain', buffer: Buffer.from('Dear hiring manager,\n') }
const REFERENCES = {
  name: 'references.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7\nReferences\n')
}
const PHOTO = { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('\x89PNG\r\n\x1a\n') }

/** The names a file list shows, in order. */
function listedNames(page: Page, listName = 'Chosen files') {
  return page.getByRole('list', { name: listName }).getByRole('listitem')
}

/** The files an email carried, by name, with their bytes as text. */
function attachedFiles(email: RecordedEmail | undefined) {
  return (email?.attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    text: Buffer.from(attachment.content, 'base64').toString('utf8')
  }))
}

test('two picks add up, and the form sends every listed file', async ({ page, deliveries }) => {
  await page.goto(FILES_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('CV and cover letter').setInputFiles([CV])
  await page.getByLabel('CV and cover letter').setInputFiles([COVER_LETTER])

  await expect(listedNames(page)).toHaveText([/cv\.pdf/, /cover-letter\.txt/])
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByRole('status')).toHaveText(SUCCESS_COPY)
  await expect(listedNames(page)).toHaveCount(0)
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect(attachedFiles((await deliveries())[0])).toEqual([
    { filename: 'cv.pdf', contentType: 'application/pdf', text: CV.buffer.toString('utf8') },
    { filename: 'cover-letter.txt', contentType: 'text/plain', text: COVER_LETTER.buffer.toString('utf8') }
  ])
})

test('a removed file is not sent, and focus moves to the next remove control', async ({ page, deliveries }) => {
  await page.goto(FILES_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('CV and cover letter').setInputFiles([CV, COVER_LETTER, REFERENCES])

  await listedNames(page).filter({ hasText: 'cv.pdf' }).getByRole('button', { name: 'Remove' }).click()

  await expect(listedNames(page)).toHaveText([/cover-letter\.txt/, /references\.pdf/])
  await expect(listedNames(page).filter({ hasText: 'cover-letter.txt' }).getByRole('button')).toBeFocused()

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toHaveText(SUCCESS_COPY)
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect(attachedFiles((await deliveries())[0]).map((file) => file.filename)).toEqual([
    'cover-letter.txt',
    'references.pdf'
  ])
})

test('a file of the wrong type holds the form back and reports it like a refusal', async ({ page, deliveries }) => {
  const typeMessage = 'That file type is not accepted. Please attach PDF or Text.'
  await page.goto(FILES_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('CV and cover letter').setInputFiles([CV, PHOTO])

  const photoItem = listedNames(page).filter({ hasText: 'photo.png' })
  await expect(photoItem).toContainText(typeMessage)
  await expect(photoItem.getByRole('button', { name: 'Remove' })).toHaveAccessibleDescription(
    `photo.png ${typeMessage}`
  )
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByRole('status')).toHaveText(typeMessage)
  await expect(page.getByLabel('CV and cover letter')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('link', { name: typeMessage })).toBeVisible()
  await expect(page.locator('[data-astro-form-field-error-summary]')).toBeFocused()
  expect(await deliveries()).toHaveLength(0)

  await photoItem.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByLabel('CV and cover letter')).not.toHaveAttribute('aria-invalid')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toHaveText(SUCCESS_COPY)
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect(attachedFiles((await deliveries())[0]).map((file) => file.filename)).toEqual(['cv.pdf'])
})

test('without a summary, a held-back file takes focus to a remove control that names it', async ({
  page,
  deliveries
}) => {
  const typeMessage = 'That file type is not accepted. Please attach PDF.'
  await page.goto(SINGLE_FILE_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('CV').setInputFiles([PHOTO])
  await page.getByRole('button', { name: 'Send' }).click()

  const removeButton = page.getByRole('button', { name: 'Remove photo.png' })
  await expect(removeButton).toBeFocused()
  await expect(removeButton).toHaveAccessibleDescription(`photo.png ${typeMessage}`)
  await expect(page.getByRole('status')).toHaveText(typeMessage)
  expect(await deliveries()).toHaveLength(0)
})

test('a refused submission keeps the chosen files for the next try', async ({ page, deliveries }) => {
  await page.goto(FILES_PAGE_PATH)
  await page.getByLabel('CV and cover letter').setInputFiles([CV, COVER_LETTER])
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true')
  await expect(listedNames(page)).toHaveText([/cv\.pdf/, /cover-letter\.txt/])

  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toHaveText(SUCCESS_COPY)
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect(attachedFiles((await deliveries())[0]).map((file) => file.filename)).toEqual(['cv.pdf', 'cover-letter.txt'])
})

test('a single-file field replaces its file on a new pick', async ({ page, deliveries }) => {
  await page.goto(SINGLE_FILE_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('CV').setInputFiles([CV])
  await page.getByLabel('CV').setInputFiles([REFERENCES])

  await expect(listedNames(page, 'Chosen file')).toHaveText([/references\.pdf/])
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toHaveText(SUCCESS_COPY)
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect(attachedFiles((await deliveries())[0]).map((file) => file.filename)).toEqual(['references.pdf'])
})

test('two forms with a cv field keep their files apart', async ({ page, deliveries }) => {
  await page.goto(TWO_FORMS_PAGE_PATH)
  await page.getByLabel('Your CV').setInputFiles([CV])
  await page.getByLabel('Friend’s CV').setInputFiles([REFERENCES])

  await expect(listedNames(page, 'Your chosen files')).toHaveText([/cv\.pdf/])
  await expect(listedNames(page, 'Friend’s chosen files')).toHaveText([/references\.pdf/])

  await page.getByLabel('Your name').fill('Ada Lovelace')
  await page.getByRole('button', { name: 'Send application' }).click()
  await expect(listedNames(page, 'Your chosen files')).toHaveCount(0)
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect(attachedFiles((await deliveries())[0]).map((file) => file.filename)).toEqual(['cv.pdf'])
  await expect(listedNames(page, 'Friend’s chosen files')).toHaveText([/references\.pdf/])
})

test.describe(() => {
  test.use({ javaScriptEnabled: false })

  test('without JavaScript, a multi-file field posts every file', async ({ page, deliveries }) => {
    await page.goto(FILES_PAGE_PATH)
    await page.getByLabel('Name').fill('Ada Lovelace')
    await page.getByLabel('CV and cover letter').setInputFiles([CV, COVER_LETTER])
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.locator('body')).toHaveText('Form submitted. Please return to the home page.')
    await expect.poll(async () => (await deliveries()).length).toBe(1)
    expect(attachedFiles((await deliveries())[0])).toEqual([
      { filename: 'cv.pdf', contentType: 'application/pdf', text: CV.buffer.toString('utf8') },
      { filename: 'cover-letter.txt', contentType: 'text/plain', text: COVER_LETTER.buffer.toString('utf8') }
    ])
  })
})

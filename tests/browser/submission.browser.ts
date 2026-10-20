import type { Page } from '@playwright/test'
import { expect, test } from './support/test.ts'

const CONTACT_PAGE_PATH = '/contact.html'

const VALIDATION_SUMMARY = 'Please correct the errors and try again.'
const EMAIL_ERROR = 'Please enter a valid email address.'
const MESSAGE_ERROR = 'Please enter a message.'

/** Fill the contact form the way a person would, leaving any field given as `undefined` untouched. */
async function fillContactForm(page: Page, fields: { name?: string; email?: string; message?: string }) {
  if (fields.name !== undefined) await page.getByLabel('Name').fill(fields.name)
  if (fields.email !== undefined) await page.getByLabel('Email').fill(fields.email)
  if (fields.message !== undefined) await page.getByLabel('Message').fill(fields.message)
}

test('submits and shows the success panel', async ({ page, deliveries }) => {
  await page.goto(CONTACT_PAGE_PATH)
  await fillContactForm(page, { name: 'Ada Lovelace', email: 'ada@example.com', message: 'I would like a quote.' })
  await page.getByRole('button', { name: 'Send' }).click()

  const successPanel = page.getByRole('status').filter({ hasText: "Thanks, we'll be in touch." })
  await expect(successPanel).toBeVisible()
  await expect(successPanel).toBeFocused()
  await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0)
  await expect(page).toHaveURL(CONTACT_PAGE_PATH)

  await expect.poll(async () => (await deliveries()).length).toBe(1)
  const emails = await deliveries()
  expect(emails[0]).toMatchObject({ from: 'site@example.com', to: 'owner@example.com', replyTo: 'ada@example.com' })
  expect(emails[0]?.text).toContain('Ada Lovelace')
  expect(emails[0]?.text).toContain('I would like a quote.')
})

test('shows field errors from the server and clears them as the person edits', async ({ page, deliveries }) => {
  await page.goto(CONTACT_PAGE_PATH)
  await fillContactForm(page, { name: 'Ada Lovelace', email: 'not-an-email' })
  await page.getByRole('button', { name: 'Send' }).click()

  const nameInput = page.getByLabel('Name')
  const emailInput = page.getByLabel('Email')
  const messageInput = page.getByLabel('Message')
  await expect(page.getByRole('status')).toHaveText(VALIDATION_SUMMARY)
  await expect(emailInput).toHaveAttribute('aria-invalid', 'true')
  await expect(emailInput).toHaveAccessibleDescription(EMAIL_ERROR)
  await expect(emailInput).toBeFocused()
  await expect(messageInput).toHaveAttribute('aria-invalid', 'true')
  await expect(messageInput).toHaveAccessibleDescription(MESSAGE_ERROR)
  await expect(nameInput).not.toHaveAttribute('aria-invalid')
  await expect(page.getByText(EMAIL_ERROR)).toBeVisible()
  await expect(page.getByText(MESSAGE_ERROR)).toBeVisible()

  await emailInput.fill('ada@example.com')
  await expect(emailInput).not.toHaveAttribute('aria-invalid')
  await expect(emailInput).toHaveAccessibleDescription('')
  await expect(page.getByText(EMAIL_ERROR)).toBeHidden()
  await expect(messageInput).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText(MESSAGE_ERROR)).toBeVisible()

  await messageInput.fill('I would like a quote.')
  await expect(messageInput).not.toHaveAttribute('aria-invalid')
  await expect(page.getByText(MESSAGE_ERROR)).toBeHidden()
  expect(await deliveries()).toHaveLength(0)

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status').filter({ hasText: "Thanks, we'll be in touch." })).toBeVisible()
  await expect.poll(async () => (await deliveries()).length).toBe(1)
})

test.describe(() => {
  test.use({ javaScriptEnabled: false })

  test('without JavaScript, posts natively and shows the readable confirmation', async ({ page, deliveries }) => {
    await page.goto(CONTACT_PAGE_PATH)
    await fillContactForm(page, { name: 'Ada Lovelace', email: 'ada@example.com', message: 'I would like a quote.' })

    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/contact')
    await page.getByRole('button', { name: 'Send' }).click()
    const response = await responsePromise

    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8')
    await expect(page).toHaveURL('/api/contact')
    await expect(page.locator('body')).toHaveText('Form submitted. Please return to the home page.')

    await expect.poll(async () => (await deliveries()).length).toBe(1)
    const emails = await deliveries()
    expect(emails[0]).toMatchObject({ to: 'owner@example.com', replyTo: 'ada@example.com' })
    expect(emails[0]?.text).toContain('Ada Lovelace')
  })

  test('without JavaScript, a refusal shows the plain-text message with the way back', async ({ page, deliveries }) => {
    await page.goto(CONTACT_PAGE_PATH)
    await fillContactForm(page, { name: 'Ada Lovelace', email: 'not-an-email' })

    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/contact')
    await page.getByRole('button', { name: 'Send' }).click()
    const response = await responsePromise

    expect(response.status()).toBe(400)
    expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8')
    expect(await response.text()).toBe(
      [
        VALIDATION_SUMMARY,
        EMAIL_ERROR,
        MESSAGE_ERROR,
        '',
        'Please go back and try again. If JavaScript is turned off in your browser, turning it on may help.'
      ].join('\n')
    )

    const pageBody = page.locator('body')
    await expect(pageBody).toContainText(VALIDATION_SUMMARY)
    await expect(pageBody).toContainText(EMAIL_ERROR)
    await expect(pageBody).toContainText(MESSAGE_ERROR)
    await expect(pageBody).toContainText('Please go back and try again.')
    expect(await deliveries()).toHaveLength(0)

    await page.goBack()
    await expect(page).toHaveURL(CONTACT_PAGE_PATH)
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  })
})

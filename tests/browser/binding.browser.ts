import { expect, test } from './support/test.ts'

const LATE_FORM_PAGE_PATH = '/late-form.html'
const DRAWER_PAGE_PATH = '/drawer.html'

const SUCCESS_COPY = "Thanks, we'll be in touch."
const EMAIL_ERROR = 'Please enter a valid email address.'

test('a form inserted after load is enhanced', async ({ page, deliveries }) => {
  await page.goto(LATE_FORM_PAGE_PATH)
  await page.getByRole('button', { name: 'Show the form' }).click()

  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('Email').fill('ada@example.com')
  await page.getByLabel('Message').fill('I would like a quote.')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByRole('status')).toHaveText(SUCCESS_COPY)
  await expect(page).toHaveURL(LATE_FORM_PAGE_PATH)
  await expect(page.getByLabel('Name')).toHaveValue('')

  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect((await deliveries())[0]?.text).toContain('I would like a quote.')
})

test('a form moved into a drawer keeps working and keeps its state', async ({ page, deliveries }) => {
  await page.goto(DRAWER_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('Email').fill('not-an-email')
  await page.getByLabel('Message').fill('I would like a quote.')
  await page.getByRole('button', { name: 'Send' }).click()

  const emailInput = page.getByLabel('Email')
  await expect(emailInput).toHaveAttribute('aria-invalid', 'true')
  await expect(emailInput).toHaveAccessibleDescription(EMAIL_ERROR)

  await page.getByRole('button', { name: 'Open the drawer' }).click()
  const drawer = page.getByRole('complementary', { name: 'Drawer' })
  await expect(drawer.getByLabel('Email')).toBeVisible()

  await expect(drawer.getByLabel('Name')).toHaveValue('Ada Lovelace')
  await expect(emailInput).toHaveValue('not-an-email')
  await expect(emailInput).toHaveAttribute('aria-invalid', 'true')
  await expect(emailInput).toHaveAccessibleDescription(EMAIL_ERROR)

  await emailInput.fill('ada@example.com')
  await expect(emailInput).not.toHaveAttribute('aria-invalid')
  await expect(page.getByText(EMAIL_ERROR)).toBeHidden()

  await drawer.getByRole('button', { name: 'Send' }).click()
  await expect(drawer.getByRole('status')).toHaveText(SUCCESS_COPY)
  await expect(page).toHaveURL(DRAWER_PAGE_PATH)

  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect((await deliveries())[0]).toMatchObject({ replyTo: 'ada@example.com' })
})

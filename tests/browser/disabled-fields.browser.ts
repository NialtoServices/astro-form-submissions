import { expect, test } from './support/test.ts'

const CONDITIONAL_PAGE_PATH = '/conditional.html'
const BUDGET_ERROR = 'Please enter a budget.'

test('sends only the fields of the section the visitor chose', async ({ page, deliveries }) => {
  await page.goto(CONDITIONAL_PAGE_PATH)
  await expect(page.getByLabel('Topic')).toBeVisible()
  await expect(page.getByLabel('Budget')).toBeHidden()

  // A budget typed while the quote section was showing is left behind with it.
  await page.getByLabel('Enquiry type').selectOption('quote')
  await expect(page.getByLabel('Budget')).toBeVisible()
  await expect(page.getByLabel('Topic')).toBeHidden()
  await page.getByLabel('Budget').fill('2500')

  await page.getByLabel('Enquiry type').selectOption('general')
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('Topic').fill('Opening hours')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByRole('status')).toHaveText("Thanks, we'll be in touch.")
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  const emailText = (await deliveries())[0]?.text
  expect(emailText).toContain('Ada Lovelace')
  expect(emailText).toContain('Opening hours')
  expect(emailText).not.toContain('2500')
})

test('sends a field that is only hidden', async ({ page, deliveries }) => {
  await page.goto(CONDITIONAL_PAGE_PATH)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByRole('status')).toHaveText("Thanks, we'll be in touch.")
  await expect.poll(async () => (await deliveries()).length).toBe(1)
  expect((await deliveries())[0]?.text).toContain('REF-1042')
})

test('clears the errors of a section the site disables', async ({ page, deliveries }) => {
  await page.goto(CONDITIONAL_PAGE_PATH)
  await page.getByLabel('Enquiry type').selectOption('quote')
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByRole('button', { name: 'Send' }).click()

  const budgetInput = page.getByLabel('Budget')
  await expect(budgetInput).toHaveAttribute('aria-invalid', 'true')
  await expect(budgetInput).toHaveAccessibleDescription(BUDGET_ERROR)
  await expect(page.getByText(BUDGET_ERROR)).toBeVisible()

  await page.getByLabel('Enquiry type').selectOption('general')
  await expect(budgetInput).not.toHaveAttribute('aria-invalid')
  await expect(budgetInput).toHaveAccessibleDescription('')
  await expect(page.getByText(BUDGET_ERROR)).toBeHidden()
  expect(await deliveries()).toHaveLength(0)
})

test.describe(() => {
  test.use({ javaScriptEnabled: false })

  test('without JavaScript, shows every section and submits every field', async ({ page, deliveries }) => {
    await page.goto(CONDITIONAL_PAGE_PATH)
    await expect(page.getByLabel('Topic')).toBeVisible()
    await expect(page.getByLabel('Budget')).toBeVisible()

    await page.getByLabel('Name').fill('Ada Lovelace')
    await page.getByLabel('Topic').fill('Opening hours')
    await page.getByLabel('Budget').fill('2500')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.locator('body')).toHaveText('Form submitted. Please return to the home page.')
    await expect.poll(async () => (await deliveries()).length).toBe(1)
    const emailText = (await deliveries())[0]?.text
    expect(emailText).toContain('Opening hours')
    expect(emailText).toContain('2500')
    expect(emailText).toContain('REF-1042')
  })
})

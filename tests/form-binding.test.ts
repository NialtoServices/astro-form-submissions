// @vitest-environment happy-dom
import { initializeForms } from '#client/form.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubFetch } from './support/harness.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Markup for an enhanceable form, with the status element left out when `status` is false. */
function formMarkup({ id = 'contact', status = true } = {}) {
  const statusMarkup = status
    ? `<p
        data-astro-form-status
        data-astro-form-message-success="Thanks."
        data-astro-form-message-generic-error="Something went wrong."
      ></p>`
    : ''
  return `
    <form id="${id}" data-astro-form action="/api/${id}" method="POST">
      <input type="text" name="email" />
      <p data-astro-form-field-error-for="email" id="${id}-email-error" hidden></p>
      <button type="submit">Send</button>
      ${statusMarkup}
    </form>`
}

/** Build a form element from {@link formMarkup}, not yet in the document. */
function createForm(options: Parameters<typeof formMarkup>[0] = {}): HTMLFormElement {
  const templateElement = document.createElement('template')
  templateElement.innerHTML = formMarkup(options)
  const formElement = templateElement.content.querySelector('form')
  if (!formElement) throw new Error('The form markup has no form')

  return formElement
}

/** Submit the form as a browser would, returning whether the native submission went ahead. */
function submit(formElement: HTMLFormElement): boolean {
  return formElement.dispatchEvent(new Event('submit', { cancelable: true }))
}

function statusOf(formElement: HTMLFormElement): HTMLElement {
  const statusElement = formElement.querySelector<HTMLElement>('[data-astro-form-status]')
  if (!statusElement) throw new Error('The form has no status element')

  return statusElement
}

/** Let the page's mutation observers, and anything they queue, run. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('form binding', () => {
  it('binds a form added after initialisation', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    initializeForms()

    const formElement = createForm()
    document.body.append(formElement)
    await settle()

    expect(submit(formElement)).toBe(false)
    await vi.waitFor(() => expect(statusOf(formElement).dataset.astroFormState).toBe('success'))
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(statusOf(formElement).textContent).toBe('Thanks.')
  })

  it('binds a form nested inside content added after initialisation', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    initializeForms()

    const sectionElement = document.createElement('section')
    sectionElement.innerHTML = formMarkup()
    document.body.append(sectionElement)
    await settle()

    const formElement = sectionElement.querySelector('form')
    if (!formElement) throw new Error('The section has no form')

    expect(submit(formElement)).toBe(false)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
  })

  it('calling initializeForms twice binds once', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    document.body.innerHTML = formMarkup()
    initializeForms()
    initializeForms()
    await settle()
    initializeForms()

    const formElement = document.querySelector('form')
    if (!formElement) throw new Error('The page has no form')

    submit(formElement)
    await vi.waitFor(() => expect(statusOf(formElement).dataset.astroFormState).toBe('success'))
    await settle()
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('a form moved into a drawer keeps working and keeps its state', async () => {
    const fetchSpy = stubFetch(async () =>
      jsonResponse({ error: 'Please correct the highlighted fields.', fieldErrors: { email: 'Enter an email.' } }, 400)
    )
    initializeForms()
    document.body.innerHTML = `<main>${formMarkup()}</main><aside class="drawer"></aside>`
    await settle()

    const formElement = document.querySelector('form')
    const drawerElement = document.querySelector('.drawer')
    const emailElement = document.querySelector<HTMLInputElement>('input[name="email"]')
    if (!formElement || !drawerElement || !emailElement) throw new Error('The page is missing its parts')

    emailElement.value = 'not-an-email'
    submit(formElement)
    await vi.waitFor(() => expect(emailElement.getAttribute('aria-invalid')).toBe('true'))

    drawerElement.append(formElement)
    await settle()

    expect(emailElement.value).toBe('not-an-email')
    expect(emailElement.getAttribute('aria-describedby')).toBe('contact-email-error')
    expect(statusOf(formElement).textContent).toBe('Please correct the highlighted fields.')

    emailElement.value = 'ada@example.com'
    emailElement.dispatchEvent(new Event('input', { bubbles: true }))
    expect(emailElement.hasAttribute('aria-invalid')).toBe(false)

    expect(submit(formElement)).toBe(false)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('a form put back after being removed works and sends one request per submit', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    document.body.innerHTML = formMarkup()
    initializeForms()

    const formElement = document.querySelector('form')
    if (!formElement) throw new Error('The page has no form')

    formElement.remove()
    await settle()
    document.body.append(formElement)
    await settle()

    expect(submit(formElement)).toBe(false)
    await vi.waitFor(() => expect(statusOf(formElement).dataset.astroFormState).toBe('success'))
    await settle()
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('an invalid form logs and leaves other forms working', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    document.body.innerHTML = formMarkup({ id: 'broken', status: false }) + formMarkup({ id: 'contact' })
    initializeForms()

    const brokenFormElement = document.querySelector<HTMLFormElement>('#broken')
    const workingFormElement = document.querySelector<HTMLFormElement>('#contact')
    if (!brokenFormElement || !workingFormElement) throw new Error('The page is missing a form')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[data-astro-form-status]'), brokenFormElement)
    expect(submit(brokenFormElement)).toBe(true)

    expect(submit(workingFormElement)).toBe(false)
    await vi.waitFor(() => expect(statusOf(workingFormElement).dataset.astroFormState).toBe('success'))
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/api\/contact$/)
  })

  it('an invalid form added after initialisation logs and leaves other forms working', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    initializeForms()

    const brokenFormElement = createForm({ id: 'broken', status: false })
    const workingFormElement = createForm({ id: 'contact' })
    document.body.append(brokenFormElement, workingFormElement)
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[data-astro-form-status]'), brokenFormElement)
    expect(submit(brokenFormElement)).toBe(true)
    expect(submit(workingFormElement)).toBe(false)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
  })
})

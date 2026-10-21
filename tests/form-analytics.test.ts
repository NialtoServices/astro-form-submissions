// @vitest-environment happy-dom
import { initializeForms } from '#client/form.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubFetch } from './support/harness.js'

type AnalyticsWindow = { dataLayer?: unknown[] }

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Mount an enhanced quote form, with `attributes` as written in its markup. */
function mountForm(attributes = 'data-astro-form-analytics="quote"') {
  document.body.innerHTML = `
    <form data-astro-form ${attributes} action="/api/quote" method="POST">
      <input type="text" name="name" value="Ada" />
      <button type="submit">Send</button>
      <p data-astro-form-status data-astro-form-message-success="Thanks."></p>
    </form>`
  initializeForms()

  const form = document.querySelector<HTMLFormElement>('form')!
  const status = document.querySelector<HTMLElement>('[data-astro-form-status]')!
  return { form, status, submit: () => form.dispatchEvent(new Event('submit', { cancelable: true })) }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as AnalyticsWindow).dataLayer
  document.body.innerHTML = ''
})

describe('form analytics', () => {
  it('pushes form_submission with the form’s name on success', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const { status, submit } = mountForm()
    expect((window as AnalyticsWindow).dataLayer).toBeUndefined()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect((window as AnalyticsWindow).dataLayer).toEqual([{ event: 'form_submission', form_name: 'quote' }])
  })

  it('adds to a dataLayer the page already has, without replacing it', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const existingLayer: unknown[] = [{ event: 'gtm.js' }]
    ;(window as AnalyticsWindow).dataLayer = existingLayer
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect((window as AnalyticsWindow).dataLayer).toBe(existingLayer)
    expect(existingLayer).toEqual([{ event: 'gtm.js' }, { event: 'form_submission', form_name: 'quote' }])
  })

  it('pushes on a silent spam drop too, which the server answers as a success', async () => {
    stubFetch(async () => jsonResponse({ ok: true }, 200))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect((window as AnalyticsWindow).dataLayer).toHaveLength(1)
  })

  it('pushes once for each successful submission', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
    status.dataset.astroFormState = 'pending'
    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect((window as AnalyticsWindow).dataLayer).toHaveLength(2)
  })

  it('never pushes on a refusal', async () => {
    stubFetch(async () => jsonResponse({ ok: false, error: 'No.', fieldErrors: { name: 'Required' } }, 422))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))

    expect((window as AnalyticsWindow).dataLayer).toBeUndefined()
  })

  it('never pushes for a form without the attribute', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const { status, submit } = mountForm('')

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect((window as AnalyticsWindow).dataLayer).toBeUndefined()
  })

  it('warns once and pushes nothing when the attribute is empty', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { status, submit } = mountForm('data-astro-form-analytics=""')

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
    initializeForms()

    expect(warning).toHaveBeenCalledOnce()
    expect(warning.mock.calls[0]![0]).toContain('[astro-form-submissions]')
    expect((window as AnalyticsWindow).dataLayer).toBeUndefined()
  })
})

// @vitest-environment happy-dom
import { initializeForms } from '#client/form.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubFetch } from './support/harness.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Mount a standard enhanced form and return handles to interact with it. */
function mountForm({ successPanel = false } = {}) {
  document.body.innerHTML = `
    <form data-astro-form action="/api/contact" method="POST">
      <input type="text" name="name" />
      <div class="cf-turnstile"></div>
      <button type="submit">Send</button>
      <p
        data-astro-form-status
        data-astro-form-message-sending="Sending…"
        data-astro-form-message-success="Thanks — we'll be in touch."
        data-astro-form-message-generic-error="Something went wrong."
        data-astro-form-message-network-error="Could not reach the server."
      ></p>
    </form>${successPanel ? '<div data-astro-form-success role="status" tabindex="-1" hidden><h2>Thanks!</h2></div>' : ''}`
  initializeForms()

  const form = document.querySelector<HTMLFormElement>('form[data-astro-form]')!
  const status = document.querySelector<HTMLElement>('[data-astro-form-status]')!
  const input = document.querySelector<HTMLInputElement>('input[name="name"]')!

  // Simulate the user typing (runtime value, not markup default) so `form.reset()` visibly clears it.
  input.value = 'Ada'
  const submit = () => form.dispatchEvent(new Event('submit', { cancelable: true }))
  return { form, status, input, submit }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete (window as { turnstile?: unknown }).turnstile
  document.body.innerHTML = ''
})

describe('form script', () => {
  it('posts the form data and shows the success state', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { form, status, input, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [requestUrl, requestInit] = fetchSpy.mock.calls[0]!
    expect(requestUrl).toBe(form.action)
    expect(requestInit?.method).toBe('POST')
    expect(requestInit?.body).toBeInstanceOf(FormData)
    expect(status.textContent).toBe("Thanks — we'll be in touch.")
    expect(input.value).toBe('')
  })

  it('shows the server-provided error copy on a failed submission', async () => {
    stubFetch(async () => jsonResponse({ error: 'Please complete the required fields.' }, 400))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
    expect(status.textContent).toBe('Please complete the required fields.')
  })

  it('falls back to the generic error copy when the server sends none', async () => {
    stubFetch(async () => jsonResponse({}, 500))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
    expect(status.textContent).toBe('Something went wrong.')
  })

  it('treats a 200 with an unparseable body as an error, not a success', async () => {
    stubFetch(async () => new Response('not json', { status: 200 }))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
  })

  it('shows the network-error copy when the request fails outright', async () => {
    stubFetch(() => Promise.reject(new Error('offline')))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
    expect(status.textContent).toBe('Could not reach the server.')
  })

  it('sends exactly one request for rapid double submissions', async () => {
    let resolveResponse: (response: Response) => void
    const fetchSpy = stubFetch(() => new Promise<Response>((resolve) => (resolveResponse = resolve)))
    const { status, submit } = mountForm()

    submit()
    submit()
    resolveResponse!(jsonResponse({ ok: true }))
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('resets only the submitting form’s Turnstile widget after success', async () => {
    const turnstileReset = vi.fn()
    ;(window as { turnstile?: { reset: typeof turnstileReset } }).turnstile = { reset: turnstileReset }
    stubFetch(async () => jsonResponse({ ok: true }))
    const { form, status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
    expect(turnstileReset).toHaveBeenCalledWith(form.querySelector('.cf-turnstile'))
  })

  it('survives a missing Turnstile widget or global without breaking the success state', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const { form, status, submit } = mountForm()
    form.querySelector('.cf-turnstile')!.remove()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
  })

  it('marks the status element as a polite live region when the markup omits it', () => {
    const { status } = mountForm()
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
  })

  it('preserves explicit live-region attributes from the site markup', () => {
    document.body.innerHTML = `
      <form data-astro-form action="/api/contact">
        <button type="submit">Send</button>
        <p data-astro-form-status role="alert" aria-live="assertive"></p>
      </form>`
    initializeForms()
    const status = document.querySelector<HTMLElement>('[data-astro-form-status]')!
    expect(status.getAttribute('role')).toBe('alert')
    expect(status.getAttribute('aria-live')).toBe('assertive')
  })

  it('re-running initialization binds newly added forms without double-binding existing ones', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { form, status, submit } = mountForm()

    // A view-transition-style DOM update adds a second form; initialization runs again.
    const second = form.cloneNode(true) as HTMLFormElement
    delete second.dataset.astroFormBound
    document.body.append(second)
    initializeForms()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    // One request from the original form proves it wasn't double-bound…
    expect(fetchSpy).toHaveBeenCalledOnce()

    // …and the new form was bound by the re-run.
    second.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
  })
})

describe('form script submit controls', () => {
  function mountWithControl(controlMarkup: string) {
    document.body.innerHTML = `
      <form data-astro-form action="/api/contact" method="POST">
        <input type="text" name="name" value="Ada" />
        ${controlMarkup}
        <p data-astro-form-status data-astro-form-message-success="Thanks." data-astro-form-message-generic-error="Oops."></p>
      </form>`
    initializeForms()
    const form = document.querySelector<HTMLFormElement>('form[data-astro-form]')!
    const status = document.querySelector<HTMLElement>('[data-astro-form-status]')!
    return { form, status }
  }

  it('enhances a form whose control is a default <button> without a type attribute', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { form, status } = mountWithControl('<button>Send</button>')

    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('enhances a form using an <input type="submit"> control', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { form, status } = mountWithControl('<input type="submit" value="Send" />')

    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("includes the triggering control's name and value in the payload", async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { form, status } = mountWithControl(`
      <button type="submit" name="action" value="save">Save</button>
      <button type="submit" name="action" value="publish">Publish</button>`)
    const publish = form.querySelector<HTMLButtonElement>('button[value="publish"]')!

    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, submitter: publish }))
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    const body = fetchSpy.mock.calls[0]![1]?.body as FormData
    expect(body.get('action')).toBe('publish')
  })

  it('disables the triggering control while pending and re-enables it afterwards', async () => {
    let resolveResponse: (response: Response) => void
    stubFetch(() => new Promise<Response>((resolve) => (resolveResponse = resolve)))
    const { form, status } = mountWithControl('<button type="submit" name="action" value="save">Save</button>')
    const control = form.querySelector<HTMLButtonElement>('button')!

    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, submitter: control }))
    expect(control.disabled).toBe(true)

    resolveResponse!(jsonResponse({ ok: true }))
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
    expect(control.disabled).toBe(false)
  })
})

describe('form script failure handling', () => {
  it('refreshes the Turnstile widget after a failed delivery so a retry gets a fresh token', async () => {
    const turnstileReset = vi.fn()
    ;(window as { turnstile?: { reset: typeof turnstileReset } }).turnstile = { reset: turnstileReset }
    stubFetch(async () => jsonResponse({ error: 'Could not send your message right now.' }, 502))
    const { form, status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
    expect(turnstileReset).toHaveBeenCalledWith(form.querySelector('.cf-turnstile'))
  })

  it('refreshes the Turnstile widget after a network failure too', async () => {
    const turnstileReset = vi.fn()
    ;(window as { turnstile?: { reset: typeof turnstileReset } }).turnstile = { reset: turnstileReset }
    stubFetch(() => Promise.reject(new Error('offline')))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
    expect(turnstileReset).toHaveBeenCalledOnce()
  })

  it('aborts a stalled request after the timeout and shows the network-error state', async () => {
    vi.useFakeTimers()
    stubFetch(
      (_requestUrl, requestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestInit?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          )
        })
    )
    const { form, status, submit } = mountForm()
    form.dataset.astroFormSubmitTimeout = '50'

    submit()
    await vi.advanceTimersByTimeAsync(51)

    expect(status.dataset.astroFormState).toBe('error')
    expect(status.textContent).toBe('Could not reach the server.')

    // The form must be retryable, not permanently pending.
    expect(form.dataset.astroFormSubmitting).toBeUndefined()
  })

  it.each(['-5', 'NaN', '0'])(
    'ignores a non-positive/non-finite timeout override (%s) and submits normally',
    async (badTimeout) => {
      const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
      const { form, status, submit } = mountForm()
      form.dataset.astroFormSubmitTimeout = badTimeout

      submit()
      // A -5/NaN/0 timeout would abort immediately; falling back to the default keeps the request alive.
      await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
      expect(fetchSpy).toHaveBeenCalledOnce()
    }
  )

  it('treats a 2xx response without the ok discriminator as an error', async () => {
    stubFetch(async () => jsonResponse({}, 200))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
    expect(status.textContent).toBe('Something went wrong.')
  })

  it("shows a 2xx body's error copy rather than the success state", async () => {
    stubFetch(async () => jsonResponse({ error: 'Upstream said no.' }, 200))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
    expect(status.textContent).toBe('Upstream said no.')
  })

  it('stays successful when the Turnstile reset throws after confirmed delivery', async () => {
    ;(window as { turnstile?: { reset: () => void } }).turnstile = {
      reset: () => {
        throw new Error('loader mismatch')
      }
    }
    stubFetch(async () => jsonResponse({ ok: true }))
    const { status, submit } = mountForm()

    let errorEmitted = false
    document.addEventListener('astro-form:error', () => (errorEmitted = true))

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
    expect(errorEmitted).toBe(false)
  })
})

describe('form script field errors', () => {
  /** A form with named fields and, optionally, co-located error slots (Mode 2) and a central list. */
  function mountFieldsForm({ slots = false, summary = false } = {}) {
    const slotFor = (name: string, id: string) =>
      slots ? `<p class="field-error" data-astro-form-field-error-for="${name}" id="${id}" hidden></p>` : ''
    document.body.innerHTML = `
      <form data-astro-form action="/api/contact" method="POST">
        ${summary ? '<div class="error-summary" data-astro-form-field-error-summary hidden></div>' : ''}
        <input id="contact-email" name="email" type="email" />
        ${slotFor('email', 'contact-email-error')}
        <textarea id="contact-message" name="message"></textarea>
        ${slotFor('message', 'contact-message-error')}
        <button type="submit">Send</button>
        <p data-astro-form-status data-astro-form-message-generic-error="Something went wrong."></p>
      </form>`
    initializeForms()
    const form = document.querySelector<HTMLFormElement>('form[data-astro-form]')!
    const status = document.querySelector<HTMLElement>('[data-astro-form-status]')!
    const email = document.querySelector<HTMLInputElement>('[name="email"]')!
    const message = document.querySelector<HTMLTextAreaElement>('[name="message"]')!
    const submit = () => form.dispatchEvent(new Event('submit', { cancelable: true }))
    return { form, status, email, message, submit }
  }

  const validationResponse = () =>
    jsonResponse(
      {
        error: 'Please correct the highlighted fields.',
        fieldErrors: { email: 'Enter a valid email.', message: 'Message is too long.' }
      },
      400
    )

  it('marks each named field invalid and shows the summary (Mode 1, no slots)', async () => {
    stubFetch(async () => validationResponse())
    const { status, email, message, submit } = mountFieldsForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))
    expect(status.textContent).toBe('Please correct the highlighted fields.')
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(message.getAttribute('aria-invalid')).toBe('true')
  })

  it('fills and links a co-located slot when the markup provides one (Mode 2)', async () => {
    stubFetch(async () => validationResponse())
    const { email, submit } = mountFieldsForm({ slots: true })

    submit()
    await vi.waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'))

    const slot = document.querySelector<HTMLElement>('[data-astro-form-field-error-for="email"]')!
    expect(slot.textContent).toBe('Enter a valid email.')
    expect(slot.hidden).toBe(false)
    expect(email.getAttribute('aria-describedby')).toBe('contact-email-error')
  })

  it('focuses the first invalid field', async () => {
    stubFetch(async () => validationResponse())
    const { email, submit } = mountFieldsForm()

    submit()
    await vi.waitFor(() => expect(document.activeElement).toBe(email))
  })

  it('carries the fieldErrors on the astro-form:error event', async () => {
    stubFetch(async () => validationResponse())
    const { submit } = mountFieldsForm()

    const detail = await new Promise<{ error: string; fieldErrors: Record<string, string> }>((resolve) => {
      document.addEventListener('astro-form:error', (event) => resolve((event as CustomEvent).detail), { once: true })
      submit()
    })
    expect(detail.error).toBe('Please correct the highlighted fields.')
    expect(detail.fieldErrors).toEqual({ email: 'Enter a valid email.', message: 'Message is too long.' })
  })

  it('clears a field’s error as soon as the user edits it', async () => {
    stubFetch(async () => validationResponse())
    const { email, submit } = mountFieldsForm({ slots: true })

    submit()
    await vi.waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'))

    email.value = 'ada@example.com'
    email.dispatchEvent(new Event('input', { bubbles: true }))

    expect(email.getAttribute('aria-invalid')).toBeNull()
    expect(document.querySelector<HTMLElement>('[data-astro-form-field-error-for="email"]')!.hidden).toBe(true)
  })

  it('wipes stale field marks on resubmission', async () => {
    const fetchSpy = stubFetch(async () => validationResponse())
    const { email, message, submit } = mountFieldsForm()

    submit()
    await vi.waitFor(() => expect(message.getAttribute('aria-invalid')).toBe('true'))

    // The next response flags only email; hold it open to observe the clear that happens on resubmit.
    let resolveSecond: (response: Response) => void
    fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => (resolveSecond = resolve)))
    submit()

    // Resubmitting clears both marks immediately, before the response returns.
    expect(email.getAttribute('aria-invalid')).toBeNull()
    expect(message.getAttribute('aria-invalid')).toBeNull()

    resolveSecond!(
      jsonResponse({ error: 'Please correct the highlighted fields.', fieldErrors: { email: 'Still invalid.' } }, 400)
    )
    await vi.waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'))
    expect(message.getAttribute('aria-invalid')).toBeNull()
  })

  it('renders a central summary list into [data-astro-form-field-error-summary], each linking to its field', async () => {
    stubFetch(async () => validationResponse())
    const { submit } = mountFieldsForm({ summary: true })
    const summary = document.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')!

    submit()
    await vi.waitFor(() => expect(summary.hidden).toBe(false))

    const links = summary.querySelectorAll('li a')
    expect([...links].map((link) => link.textContent)).toEqual(['Enter a valid email.', 'Message is too long.'])
    expect(links[0]!.getAttribute('href')).toBe('#contact-email')
  })

  it('removes only the edited field’s summary entry on input, hiding the summary when empty (COR-001)', async () => {
    stubFetch(async () => validationResponse())
    const { email, message, submit } = mountFieldsForm({ summary: true })
    const summary = document.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')!

    submit()
    await vi.waitFor(() => expect(summary.querySelectorAll('li')).toHaveLength(2))

    // Editing email drops its entry only; message's stays and the summary is still shown.
    email.dispatchEvent(new Event('input', { bubbles: true }))
    expect(summary.querySelectorAll('li')).toHaveLength(1)
    expect(summary.textContent).toContain('Message is too long.')
    expect(summary.textContent).not.toContain('Enter a valid email.')
    expect(summary.hidden).toBe(false)

    // Editing the last flagged field empties and hides the summary.
    message.dispatchEvent(new Event('input', { bubbles: true }))
    expect(summary.querySelectorAll('li')).toHaveLength(0)
    expect(summary.hidden).toBe(true)
  })

  it('focuses the summary list, and clicking an entry focuses its field', async () => {
    stubFetch(async () => validationResponse())
    const { email, submit } = mountFieldsForm({ summary: true })
    const summary = document.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')!

    submit()
    await vi.waitFor(() => expect(document.activeElement).toBe(summary))

    summary.querySelector<HTMLAnchorElement>('li a')!.click()
    expect(document.activeElement).toBe(email)
  })

  it('clears the summary list on resubmission', async () => {
    const fetchSpy = stubFetch(async () => validationResponse())
    const { submit } = mountFieldsForm({ summary: true })
    const summary = document.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')!

    submit()
    await vi.waitFor(() => expect(summary.querySelectorAll('li')).toHaveLength(2))

    let resolveSecond: (response: Response) => void
    fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => (resolveSecond = resolve)))
    submit()

    expect(summary.hidden).toBe(true)
    expect(summary.textContent).toBe('')
    resolveSecond!(jsonResponse({ ok: true }))
  })

  it('removes an aria-describedby it added once the field recovers, but keeps an author-set one', async () => {
    stubFetch(async () => validationResponse())
    const { email, message, submit } = mountFieldsForm({ slots: true })
    message.setAttribute('aria-describedby', 'author-hint')

    submit()
    await vi.waitFor(() => expect(email.getAttribute('aria-describedby')).toBe('contact-email-error'))
    // The author's describedby is never overwritten by the slot wiring.
    expect(message.getAttribute('aria-describedby')).toBe('author-hint')

    email.dispatchEvent(new Event('input', { bubbles: true }))
    message.dispatchEvent(new Event('input', { bubbles: true }))

    // The script removes only what it added; the author-authored value survives.
    expect(email.getAttribute('aria-describedby')).toBeNull()
    expect(message.getAttribute('aria-describedby')).toBe('author-hint')
  })
})

describe('form script success panel', () => {
  it('swaps the whole form out for the success panel and focuses it', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const { form, submit } = mountForm({ successPanel: true })
    const panel = document.querySelector<HTMLElement>('[data-astro-form-success]')!

    submit()
    await vi.waitFor(() => expect(panel.hidden).toBe(false))

    expect(document.contains(form)).toBe(false)
    expect(document.activeElement).toBe(panel)
    expect(panel.textContent).toBe('Thanks!')
  })

  it('keeps the inline status behaviour when no panel is present', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const { form, status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
    expect(document.contains(form)).toBe(true)
  })
})

describe('form script events', () => {
  it('emits a bubbling astro-form:success event carrying the submitted data', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const { form, submit } = mountForm()

    let detail: { data?: FormData } | undefined
    let target: EventTarget | null = null
    document.addEventListener('astro-form:success', (event) => {
      detail = (event as CustomEvent).detail
      target = event.target
    })

    submit()
    await vi.waitFor(() => expect(detail).toBeDefined())
    expect(target).toBe(form)
    expect(detail!.data!.get('name')).toBe('Ada')
  })

  it('emits astro-form:success before the panel swap, while the form is still in the page', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const { form, submit } = mountForm({ successPanel: true })

    let formWasConnected: boolean | undefined
    document.addEventListener('astro-form:success', () => {
      formWasConnected = document.contains(form)
    })

    submit()
    await vi.waitFor(() => expect(formWasConnected).toBeDefined())
    expect(formWasConnected).toBe(true)
  })

  it('emits a bubbling astro-form:error event carrying the shown message', async () => {
    stubFetch(async () => jsonResponse({ error: 'Please complete the required fields.' }, 400))
    const { submit } = mountForm()

    let detail: { error?: string } | undefined
    document.addEventListener('astro-form:error', (event) => {
      detail = (event as CustomEvent).detail
    })

    submit()
    await vi.waitFor(() => expect(detail).toBeDefined())
    expect(detail!.error).toBe('Please complete the required fields.')
  })

  it('emits astro-form:error on a network failure too', async () => {
    stubFetch(() => Promise.reject(new Error('offline')))
    const { submit } = mountForm()

    let detail: { error?: string } | undefined
    document.addEventListener('astro-form:error', (event) => {
      detail = (event as CustomEvent).detail
    })

    submit()
    await vi.waitFor(() => expect(detail).toBeDefined())
    expect(detail!.error).toBe('Could not reach the server.')
  })
})

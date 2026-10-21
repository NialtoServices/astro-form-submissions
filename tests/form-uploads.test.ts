// @vitest-environment happy-dom
import { initializeForms } from '#client/form.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubFetch } from './support/harness.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** One PUT the fake XMLHttpRequest received. */
interface SentUpload {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

/**
 * A stand-in for `XMLHttpRequest` that records each upload and answers with a status chosen per call,
 * firing upload progress at half and full size first, as a browser does for a body it can measure. A
 * `stall` outcome sends nothing and never answers, until aborted. A `slow` outcome reports a third of the body
 * every 4 seconds and answers 200 once it is all sent, 12 seconds in.
 */
function installFakeXHR(statuses: (number | 'network-error' | 'stall' | 'slow')[] = []) {
  const sent: SentUpload[] = []

  class FakeXMLHttpRequest extends EventTarget {
    readonly upload = new EventTarget()
    status = 0
    private method = ''
    private url = ''
    private readonly headers: Record<string, string> = {}

    open(method: string, url: string) {
      this.method = method
      this.url = url
    }

    setRequestHeader(name: string, value: string) {
      this.headers[name] = value
    }

    abort() {
      this.dispatchEvent(new Event('abort'))
    }

    send(body: Blob) {
      const outcome = statuses[sent.length] ?? 200
      sent.push({ method: this.method, url: this.url, headers: { ...this.headers }, body })
      if (outcome === 'stall') return
      if (outcome === 'slow') {
        for (const third of [1, 2, 3]) {
          setTimeout(() => {
            const loaded = Math.round((body.size * third) / 3)
            this.upload.dispatchEvent(
              Object.assign(new Event('progress'), { lengthComputable: true, loaded, total: body.size })
            )
            if (third < 3) return

            this.status = 200
            this.dispatchEvent(new Event('load'))
          }, third * 4_000)
        }
        return
      }

      queueMicrotask(() => {
        for (const loaded of [Math.floor(body.size / 2), body.size]) {
          this.upload.dispatchEvent(
            Object.assign(new Event('progress'), { lengthComputable: true, loaded, total: body.size })
          )
        }

        if (outcome === 'network-error') {
          this.dispatchEvent(new Event('error'))
          return
        }

        this.status = outcome
        this.dispatchEvent(new Event('load'))
      })
    }
  }

  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
  return sent
}

/** Mount a form opted into direct uploads, with a Turnstile container holding a spent token. */
function mountForm({ turnstile = true } = {}) {
  document.body.innerHTML = `
    <form data-astro-form data-astro-form-upload-action="/api/contact/uploads/" action="/api/contact/" method="POST">
      <input type="text" name="name" value="Ada" />
      <input type="file" name="file" multiple data-astro-form-upload />
      ${turnstile ? '<div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value="spent-token" /></div>' : ''}
      <button type="submit">Send</button>
      <p
        data-astro-form-status
        data-astro-form-message-sending="Sending…"
        data-astro-form-message-uploading="Uploading {current} of {total} ({percent}%)…"
        data-astro-form-message-success="Thanks!"
        data-astro-form-message-generic-error="Something went wrong."
        data-astro-form-message-network-error="Could not reach the server."
      ></p>
    </form>`
  initializeForms()

  const form = document.querySelector<HTMLFormElement>('form')!
  const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
  const status = document.querySelector<HTMLElement>('[data-astro-form-status]')!
  return { form, fileInput, status, submit: () => form.dispatchEvent(new Event('submit', { cancelable: true })) }
}

function choose(fileInput: HTMLInputElement, files: File[]) {
  Object.defineProperty(fileInput, 'files', { configurable: true, value: files })
}

const photo = new File([new Uint8Array(1000)], 'garden.jpg', { type: 'image/jpeg' })
const video = new File([new Uint8Array(3000)], 'loft.mov', { type: 'video/quicktime' })

const grants = [
  { url: 'https://uploads.example/a', method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, receipt: 'receipt-a' },
  {
    url: 'https://uploads.example/b',
    method: 'PUT',
    headers: { 'Content-Type': 'video/quicktime' },
    receipt: 'receipt-b'
  }
]

/**
 * A Turnstile global whose `reset` clears the widget's token and issues a fresh one shortly after, as the
 * real widget does.
 */
function installTurnstile() {
  const reset = vi.fn((widget: Element) => {
    const input = widget.querySelector<HTMLInputElement>('input[type="hidden"]')!
    input.value = ''
    setTimeout(() => (input.value = 'fresh-token'), 250)
  })
  ;(window as { turnstile?: unknown }).turnstile = { reset }
  return reset
}

beforeEach(() => {
  installTurnstile()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (window as { turnstile?: unknown }).turnstile
  document.body.innerHTML = ''
})

describe('form script — direct uploads', () => {
  it('asks for uploads, sends each file as instructed, then submits receipts with a fresh token', async () => {
    const sent = installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/') ? jsonResponse({ ok: true, uploads: grants }) : jsonResponse({ ok: true })
    )
    const { fileInput, status, submit } = mountForm()
    choose(fileInput, [photo, video])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'), { timeout: 2000 })

    expect(fetchSpy).toHaveBeenCalledTimes(2)

    const [uploadURL, uploadInit] = fetchSpy.mock.calls[0]!
    const uploadBody = uploadInit!.body as FormData
    expect(String(uploadURL)).toContain('/api/contact/uploads/')
    expect(uploadBody.get('name')).toBe('Ada')
    expect(uploadBody.get('cf-turnstile-response')).toBe('spent-token')
    expect(uploadBody.has('file')).toBe(false)
    expect(JSON.parse(uploadBody.get('uploads') as string)).toEqual([
      { name: 'garden.jpg', size: 1000, type: 'image/jpeg' },
      { name: 'loft.mov', size: 3000, type: 'video/quicktime' }
    ])

    expect(sent).toEqual([
      { method: 'PUT', url: grants[0]!.url, headers: grants[0]!.headers, body: photo },
      { method: 'PUT', url: grants[1]!.url, headers: grants[1]!.headers, body: video }
    ])

    const [formURL, formInit] = fetchSpy.mock.calls[1]!
    const formBody = formInit!.body as FormData
    expect(String(formURL)).toContain('/api/contact/')
    expect(formBody.getAll('upload')).toEqual(['receipt-a', 'receipt-b'])
    expect(formBody.get('cf-turnstile-response')).toBe('fresh-token')
    expect(formBody.get('name')).toBe('Ada')
    expect(formBody.has('file')).toBe(false)
  })

  it('reports every progress update as an event, and announces it as each file starts and at each quarter', async () => {
    installFakeXHR()
    stubFetch(async (url) =>
      String(url).includes('/uploads/') ? jsonResponse({ ok: true, uploads: grants }) : jsonResponse({ ok: true })
    )
    const { form, fileInput, status, submit } = mountForm()
    choose(fileInput, [photo, video])
    const messages: string[] = []
    const events: { current: number; total: number; percent: number }[] = []
    form.addEventListener('astro-form:upload-progress', (event) => {
      events.push((event as CustomEvent).detail)
      messages.push(status.textContent ?? '')
    })

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'), { timeout: 2000 })

    expect(events.map((event) => [event.current, event.total, event.percent])).toEqual([
      [1, 2, 0],
      [1, 2, 12],
      [1, 2, 25],
      [2, 2, 25],
      [2, 2, 62],
      [2, 2, 100]
    ])
    expect(messages).toEqual([
      'Uploading 1 of 2 (0%)…',
      'Uploading 1 of 2 (0%)…',
      'Uploading 1 of 2 (25%)…',
      'Uploading 2 of 2 (25%)…',
      'Uploading 2 of 2 (62%)…',
      'Uploading 2 of 2 (100%)…'
    ])
  })

  it('submits as before, without the file input, when no file is chosen', async () => {
    const sent = installFakeXHR()
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { status, submit } = mountForm()

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(String(fetchSpy.mock.calls[0]![0])).not.toContain('/uploads/')
    expect((fetchSpy.mock.calls[0]![1]!.body as FormData).has('file')).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('leaves empty files out of the uploads', async () => {
    const sent = installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { fileInput, status, submit } = mountForm({ turnstile: false })
    choose(fileInput, [new File([], 'empty.txt', { type: 'text/plain' }), photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    const descriptors = JSON.parse((fetchSpy.mock.calls[0]![1]!.body as FormData).get('uploads') as string)
    expect(descriptors).toEqual([{ name: 'garden.jpg', size: 1000, type: 'image/jpeg' }])
    expect(sent).toHaveLength(1)
  })

  it('submits as before when every chosen file is empty', async () => {
    const sent = installFakeXHR()
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { fileInput, status, submit } = mountForm({ turnstile: false })
    choose(fileInput, [new File([], 'empty.txt')])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(String(fetchSpy.mock.calls[0]![0])).not.toContain('/uploads/')
    expect(sent).toHaveLength(0)
  })

  it('leaves a disabled file input’s files out, as a form leaves out any disabled control', async () => {
    const sent = installFakeXHR()
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { fileInput, status, submit } = mountForm({ turnstile: false })
    choose(fileInput, [photo])
    fileInput.disabled = true

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(String(fetchSpy.mock.calls[0]![0])).not.toContain('/uploads/')
    expect(sent).toHaveLength(0)
  })

  it('shows the upload route’s field errors without uploading anything', async () => {
    const sent = installFakeXHR()
    const fetchSpy = stubFetch(async () =>
      jsonResponse({ error: 'Please check the form.', fieldErrors: { name: 'Please enter your name.' } }, 400)
    )
    const { fileInput, status, submit } = mountForm()
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))

    expect(status.textContent).toBe('Please check the form.')
    expect(document.querySelector('[name="name"]')!.getAttribute('aria-invalid')).toBe('true')
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(sent).toHaveLength(0)
  })

  it.each([
    ['a refused upload', [403]],
    ['a network failure mid-upload', [200, 'network-error']]
  ] as const)('stops at %s with the network-error copy and never submits', async (_label, statuses) => {
    installFakeXHR([...statuses])
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true, uploads: grants }))
    const { fileInput, status, submit } = mountForm()
    choose(fileInput, [photo, video])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))

    expect(status.textContent).toBe('Could not reach the server.')
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('gives up on an upload that stops making progress, leaving the form ready for a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sent = installFakeXHR(['stall'])
    stubFetch(async () => jsonResponse({ ok: true, uploads: grants }))
    const { form, fileInput, status, submit } = mountForm()
    form.dataset.astroFormSubmitTimeout = '5000'
    choose(fileInput, [photo, video])

    // The idle deadline starts when the upload is sent, so measure from there. Flushing with a zero advance
    // (rather than vi.waitFor, which moves fake time on every check) keeps the clock where the send left it.
    submit()
    for (let attempt = 0; attempt < 20 && sent.length === 0; attempt++) await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(status.dataset.astroFormState).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))

    expect(status.textContent).toBe('Could not reach the server.')
    expect(form.dataset.astroFormSubmitting).toBeUndefined()
  })

  it('lets an upload that keeps making progress run past the idle timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sent = installFakeXHR(['slow'])
    stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { form, fileInput, status, submit } = mountForm()
    form.dataset.astroFormSubmitTimeout = '5000'
    choose(fileInput, [photo])

    submit()
    for (let attempt = 0; attempt < 20 && sent.length === 0; attempt++) await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(12_000)
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))
  })

  it('sends the clicked control’s name and value with both requests', async () => {
    installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { form, fileInput, status } = mountForm()
    const control = form.querySelector<HTMLButtonElement>('button')!
    control.name = 'intent'
    control.value = 'quote'
    choose(fileInput, [photo])

    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, submitter: control }))
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'), { timeout: 2000 })

    expect(fetchSpy.mock.calls.map(([, init]) => (init!.body as FormData).get('intent'))).toEqual(['quote', 'quote'])
  })

  it.each([
    { ok: true, uploads: 'not a list' },
    { ok: true, uploads: [{ url: 1, method: 'PUT', headers: {}, receipt: 'r' }] },
    { ok: true, uploads: [{ url: 'https://uploads.example/a', method: 'PUT', headers: {}, receipt: 5 }] },
    { ok: true, uploads: [{ url: 'https://uploads.example/a', method: 'PUT', headers: 'x', receipt: 'r' }] },
    { ok: true }
  ])('treats a malformed grant (%j) as a generic failure and uploads nothing', async (body) => {
    const sent = installFakeXHR()
    stubFetch(async () => jsonResponse(body))
    const { fileInput, status, submit } = mountForm()
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))

    expect(status.textContent).toBe('Something went wrong.')
    expect(sent).toHaveLength(0)
  })

  it('shows the form route’s refusal after the uploads', async () => {
    installFakeXHR()
    stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants })
        : jsonResponse({ error: "One of your files didn't finish uploading. Please try again." }, 400)
    )
    const { fileInput, status, submit } = mountForm()
    choose(fileInput, [photo, video])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'), { timeout: 2000 })

    expect(status.textContent).toBe("One of your files didn't finish uploading. Please try again.")
  })

  it('treats a grant list that does not match the files as a generic failure', async () => {
    const sent = installFakeXHR()
    stubFetch(async () => jsonResponse({ ok: true, uploads: grants.slice(0, 1) }))
    const { fileInput, status, submit } = mountForm()
    choose(fileInput, [photo, video])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))

    expect(status.textContent).toBe('Something went wrong.')
    expect(sent).toHaveLength(0)
  })

  it('goes on without files when the upload route grants nothing', async () => {
    const sent = installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/') ? jsonResponse({ ok: true, uploads: [] }) : jsonResponse({ ok: true })
    )
    const { fileInput, status, submit } = mountForm()
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'), { timeout: 2000 })

    expect(sent).toHaveLength(0)
    expect((fetchSpy.mock.calls[1]![1]!.body as FormData).has('upload')).toBe(false)
  })

  it('submits after the Turnstile wait times out, leaving verification to the server', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    ;(window as { turnstile?: unknown }).turnstile = {
      reset: (widget: Element) => (widget.querySelector<HTMLInputElement>('input[type="hidden"]')!.value = '')
    }
    installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { fileInput, status, submit } = mountForm()
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('waits for a fresh token under a custom response field name', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { fileInput, status, submit } = mountForm()
    document.querySelector('.cf-turnstile input')!.setAttribute('name', 'turnstile-token')
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect((fetchSpy.mock.calls[1]![1]!.body as FormData).get('turnstile-token')).toBe('fresh-token')
  })

  it('waits for a token before asking the upload route for grants', async () => {
    installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { fileInput, status, submit } = mountForm()
    const tokenInput = document.querySelector<HTMLInputElement>('.cf-turnstile input')!
    tokenInput.value = ''
    setTimeout(() => (tokenInput.value = 'first-token'), 300)
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'), { timeout: 3000 })

    expect((fetchSpy.mock.calls[0]![1]!.body as FormData).get('cf-turnstile-response')).toBe('first-token')
  })

  it('needs no Turnstile widget at all', async () => {
    installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { fileInput, status, submit } = mountForm({ turnstile: false })
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect((fetchSpy.mock.calls[1]![1]!.body as FormData).getAll('upload')).toEqual(['receipt-a'])
  })

  it('posts the file descriptors under a custom field', async () => {
    installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { form, fileInput, status, submit } = mountForm({ turnstile: false })
    form.dataset.astroFormUploadField = 'files'
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    const descriptors = fetchSpy.mock.calls[0]![1]!.body as FormData
    expect(descriptors.has('uploads')).toBe(false)
    expect(JSON.parse(descriptors.get('files') as string)).toEqual([
      { name: 'garden.jpg', size: 1000, type: 'image/jpeg' }
    ])
  })

  it('posts receipts under a custom field', async () => {
    installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { form, fileInput, status, submit } = mountForm({ turnstile: false })
    form.dataset.astroFormUploadReceiptField = 'attachment'
    choose(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'))

    expect((fetchSpy.mock.calls[1]![1]!.body as FormData).getAll('attachment')).toEqual(['receipt-a'])
  })
})

const PROGRESS_ITEM_TEMPLATE = `
  <template>
    <li>
      <span data-astro-form-file-name></span>
      <progress data-astro-form-file-progress aria-label="Upload progress"></progress>
    </li>
  </template>`

/** Mount a form whose direct-upload field lists its files, each with a progress slot, and shows overall progress. */
function mountProgressForm() {
  document.body.innerHTML = `
    <form data-astro-form data-astro-form-upload-action="/api/contact/uploads/" action="/api/contact/" method="POST">
      <input type="file" name="file" multiple data-astro-form-upload />
      <p data-astro-form-field-error-for="file" hidden></p>
      <ul data-astro-form-file-list-for="file">${PROGRESS_ITEM_TEMPLATE}</ul>
      <progress data-astro-form-upload-progress-for="file"></progress>
      <div data-astro-form-upload-progress-for="file"></div>
      <button type="submit">Send</button>
      <p data-astro-form-status data-astro-form-message-generic-error="Something went wrong."></p>
    </form>`
  initializeForms()

  const form = document.querySelector<HTMLFormElement>('form')!
  const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
  const status = document.querySelector<HTMLElement>('[data-astro-form-status]')!
  const fieldBar = document.querySelector<HTMLProgressElement>('progress[data-astro-form-upload-progress-for]')!
  const fieldMeter = document.querySelector<HTMLElement>('div[data-astro-form-upload-progress-for]')!
  const itemBars = () => Array.from(document.querySelectorAll<HTMLProgressElement>('li progress'))
  return { form, fileInput, status, fieldBar, fieldMeter, itemBars, submit: () => form.requestSubmit() }
}

/** Choose files in the picker, as a browser does, so the field lists them. */
function pickFiles(fileInput: HTMLInputElement, files: File[]) {
  const dataTransfer = new DataTransfer()
  for (const file of files) dataTransfer.items.add(file)
  fileInput.files = dataTransfer.files
  fileInput.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('form script — upload progress', () => {
  it("each file's progress slot and the field's progress move while uploading and finish done", async () => {
    installFakeXHR()
    stubFetch(async (url) =>
      String(url).includes('/uploads/') ? jsonResponse({ ok: true, uploads: grants }) : jsonResponse({ ok: true })
    )
    const { form, fileInput, status, fieldBar, fieldMeter, itemBars, submit } = mountProgressForm()
    pickFiles(fileInput, [photo, video])

    const seen: {
      items: [number, number, string | null][]
      field: [number, number, string | null]
      meter: string
    }[] = []
    form.addEventListener('astro-form:upload-progress', () => {
      seen.push({
        items: itemBars().map((bar) => [
          bar.value,
          bar.max,
          bar.closest('li')!.getAttribute('data-astro-form-file-state')
        ]),
        field: [fieldBar.value, fieldBar.max, fieldBar.getAttribute('data-astro-form-file-state')],
        meter: fieldMeter.style.getPropertyValue('--astro-form-progress')
      })
    })

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'), { timeout: 2000 })

    expect(seen.map((snapshot) => snapshot.field)).toEqual([
      [0, 4000, 'uploading'],
      [500, 4000, 'uploading'],
      [1000, 4000, 'uploading'],
      [1000, 4000, 'uploading'],
      [2500, 4000, 'uploading'],
      [4000, 4000, 'done']
    ])
    expect(seen.map((snapshot) => snapshot.meter)).toEqual(['0', '0.125', '0.25', '0.25', '0.625', '1'])
    expect(seen[1]!.items).toEqual([
      [500, 1000, 'uploading'],
      [0, 1, null]
    ])
    expect(seen[2]!.items[0]).toEqual([1000, 1000, 'done'])
    expect(seen[5]!.items).toEqual([
      [1000, 1000, 'done'],
      [3000, 3000, 'done']
    ])
  })

  it('a failed upload returns every progress part to nothing', async () => {
    installFakeXHR([200, 'network-error'])
    stubFetch(async () => jsonResponse({ ok: true, uploads: grants }))
    const { fileInput, status, fieldBar, fieldMeter, itemBars, submit } = mountProgressForm()
    pickFiles(fileInput, [photo, video])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'), { timeout: 2000 })

    expect(fieldBar.value).toBe(0)
    expect(fieldBar.hasAttribute('data-astro-form-file-state')).toBe(false)
    expect(fieldMeter.style.getPropertyValue('--astro-form-progress')).toBe('0')
    expect(itemBars().map((bar) => [bar.value, bar.closest('li')!.hasAttribute('data-astro-form-file-state')])).toEqual(
      [
        [0, false],
        [0, false]
      ]
    )
  })

  it('a refusal from the upload route lands on the direct-upload input', async () => {
    const sent = installFakeXHR()
    stubFetch(async () =>
      jsonResponse(
        { error: 'Each file must be 1 MB or smaller.', fieldErrors: { file: 'Each file must be 1 MB or smaller.' } },
        400
      )
    )
    const { fileInput, status, submit } = mountProgressForm()
    pickFiles(fileInput, [photo])

    submit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))

    expect(fileInput.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('[data-astro-form-field-error-for="file"]')!.textContent).toBe(
      'Each file must be 1 MB or smaller.'
    )
    expect(sent).toHaveLength(0)
  })
})

describe('form script — script-only fields', () => {
  it('a script-only field is revealed when the script runs', () => {
    document.body.innerHTML = `
      <form data-astro-form action="/api/contact/" method="POST">
        <fieldset data-astro-form-requires-script hidden><input type="file" name="photos" /></fieldset>
        <p id="note" hidden>Only shown by the site</p>
        <p data-astro-form-status></p>
      </form>
      <p data-astro-form-requires-script hidden id="outside">Another form's part</p>`

    expect(document.querySelector('fieldset')!.hidden).toBe(true)

    initializeForms()

    expect(document.querySelector('fieldset')!.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('#note')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('#outside')!.hidden).toBe(true)
  })
})

describe('form script — one direct-upload input per form', () => {
  /** A form marking two file inputs for direct upload, each with its own progress part. */
  function mountTwoUploadInputs() {
    document.body.innerHTML = `
      <form data-astro-form data-astro-form-upload-action="/api/contact/uploads/" action="/api/contact/" method="POST">
        <input type="file" name="photos" data-astro-form-upload />
        <input type="file" name="videos" data-astro-form-upload />
        <progress data-astro-form-upload-progress-for="videos"></progress>
        <button type="submit">Send</button>
        <p data-astro-form-status data-astro-form-message-generic-error="Something went wrong."></p>
      </form>`
    initializeForms()
    return {
      form: document.querySelector<HTMLFormElement>('form')!,
      photosInput: document.querySelector<HTMLInputElement>('[name="photos"]')!,
      videosInput: document.querySelector<HTMLInputElement>('[name="videos"]')!,
      status: document.querySelector<HTMLElement>('[data-astro-form-status]')!
    }
  }

  it('a second direct-upload input in one form is ignored with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent = installFakeXHR()
    const fetchSpy = stubFetch(async (url) =>
      String(url).includes('/uploads/')
        ? jsonResponse({ ok: true, uploads: grants.slice(0, 1) })
        : jsonResponse({ ok: true })
    )
    const { form, photosInput, videosInput, status } = mountTwoUploadInputs()
    choose(photosInput, [photo])
    choose(videosInput, [video])

    form.requestSubmit()
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('success'), { timeout: 2000 })
    form.requestSubmit()
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4), { timeout: 2000 })

    const warnings = warnSpy.mock.calls.filter(([text]) => String(text).includes('directly from only one input'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]![0]).toContain('"photos"')
    expect(warnings[0]![0]).toContain('"videos"')

    expect(sent.map((upload) => (upload.body as File).name)).toEqual(['garden.jpg', 'garden.jpg'])
    const uploadRequest = fetchSpy.mock.calls[0]![1]!.body as FormData
    expect(JSON.parse(uploadRequest.get('uploads') as string)).toEqual([
      { name: 'garden.jpg', size: 1000, type: 'image/jpeg' }
    ])
  })
})

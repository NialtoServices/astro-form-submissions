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
 * `stall` outcome sends nothing and never answers, until aborted.
 */
function installFakeXHR(statuses: (number | 'network-error' | 'stall')[] = []) {
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

  it('reports progress across all files in the copy and as events', async () => {
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
      'Uploading 1 of 2 (12%)…',
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
    installFakeXHR(['stall'])
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true, uploads: grants }))
    const { form, fileInput, status, submit } = mountForm()
    form.dataset.astroFormSubmitTimeout = '5000'
    choose(fileInput, [photo, video])

    submit()
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(4_999)
    expect(status.dataset.astroFormState).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(status.dataset.astroFormState).toBe('error'))

    expect(status.textContent).toBe('Could not reach the server.')
    expect(form.dataset.astroFormSubmitting).toBeUndefined()
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

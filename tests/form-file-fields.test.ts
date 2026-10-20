// @vitest-environment happy-dom
import { initializeForms } from '#client/form.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubFetch } from './support/harness.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const ITEM_TEMPLATE = `
  <template>
    <li>
      <span data-astro-form-file-name></span>
      <span data-astro-form-file-size></span>
      <span data-astro-form-file-problem hidden></span>
      <button type="button" data-astro-form-file-remove>Remove</button>
    </li>
  </template>`

interface FieldOptions {
  /** The form's id, which also prefixes the input's. */
  id?: string

  /** Extra attributes on the file input, as written in markup. */
  inputAttributes?: string

  /** Whether the form has a file list for the field. */
  list?: boolean

  /** Whether the form has an error slot beside the field. */
  slot?: boolean
}

/** Markup for a job application form with a `cv` file field, its file list and an error summary. */
function formMarkup({
  id = 'application',
  inputAttributes = `multiple accept="application/pdf,text/plain,.pdf,.txt" data-astro-form-max-files="3"
    data-astro-form-max-file-bytes="1048576" data-astro-form-max-total-bytes="2097152"`,
  list = true,
  slot = false
}: FieldOptions = {}) {
  return `
    <form id="${id}" data-astro-form action="/api/${id}" method="POST" enctype="multipart/form-data">
      <input type="text" name="name" value="Ada" />
      <label for="${id}-cv">CV</label>
      <input id="${id}-cv" type="file" name="cv" ${inputAttributes} />
      ${slot ? `<p data-astro-form-field-error-for="cv" id="${id}-cv-error" hidden></p>` : ''}
      ${list ? `<ul data-astro-form-file-list-for="cv">${ITEM_TEMPLATE}</ul>` : ''}
      <div data-astro-form-field-error-summary hidden></div>
      <button type="submit">Send</button>
      <p
        data-astro-form-status
        data-astro-form-message-success="Thanks."
        data-astro-form-message-generic-error="Something went wrong."
      ></p>
    </form>`
}

/** Mount one form and enhance it, returning its parts. */
function mountForm(options: FieldOptions = {}) {
  document.body.innerHTML = formMarkup(options)
  initializeForms()
  return partsOf(document.querySelector('form'))
}

function partsOf(formElement: HTMLFormElement | null) {
  const inputElement = formElement?.querySelector<HTMLInputElement>('input[type="file"]')
  const statusElement = formElement?.querySelector<HTMLElement>('[data-astro-form-status]')
  const summaryElement = formElement?.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
  if (!formElement || !inputElement || !statusElement || !summaryElement) throw new Error('The form is missing parts')

  const listElement = formElement.querySelector<HTMLElement>('[data-astro-form-file-list-for]')
  return {
    formElement,
    inputElement,
    statusElement,
    summaryElement,
    listElement,
    submit: () => formElement.dispatchEvent(new Event('submit', { cancelable: true }))
  }
}

/** Choose files in the picker, as a browser does: the input holds only this pick, then fires input and change. */
function pick(inputElement: HTMLInputElement, files: File[]) {
  const dataTransfer = new DataTransfer()
  for (const file of files) dataTransfer.items.add(file)
  inputElement.files = dataTransfer.files
  inputElement.dispatchEvent(new Event('input', { bubbles: true }))
  inputElement.dispatchEvent(new Event('change', { bubbles: true }))
}

function pdf(name: string, size: number, lastModified = 1_700_000_000_000) {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf', lastModified })
}

/** The items a person sees in a file list: every child but the site's template. */
function listedItems(listElement: HTMLElement | null): HTMLElement[] {
  if (!listElement) throw new Error('The form has no file list')

  return Array.from(listElement.children).filter(
    (childElement): childElement is HTMLElement =>
      childElement instanceof HTMLElement && !(childElement instanceof HTMLTemplateElement)
  )
}

function slotOf(itemElement: HTMLElement | undefined, slot: 'name' | 'size' | 'problem' | 'remove'): HTMLElement {
  const slotElement = itemElement?.querySelector<HTMLElement>(`[data-astro-form-file-${slot}]`)
  if (!slotElement) throw new Error(`The item has no ${slot} slot`)

  return slotElement
}

function listedNames(listElement: HTMLElement | null): string[] {
  return listedItems(listElement).map((itemElement) => slotOf(itemElement, 'name').textContent ?? '')
}

function inputNames(inputElement: HTMLInputElement): string[] {
  return Array.from(inputElement.files ?? []).map((file) => file.name)
}

/** The names of the files a fetch call posted under `field`. */
function postedNames(fetchSpy: ReturnType<typeof stubFetch>, call = 0, field = 'cv'): string[] {
  const body = fetchSpy.mock.calls[call]?.[1]?.body
  if (!(body instanceof FormData)) throw new Error('The request had no form data')

  return body.getAll(field).map((entry) => (entry instanceof File ? entry.name : String(entry)))
}

/** Let the page's mutation observers, and anything they queue, run. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('form script — file fields', () => {
  it("lists chosen files with name and size, from the site's template", () => {
    const { inputElement, listElement } = mountForm()

    pick(inputElement, [pdf('cv.pdf', 2048)])

    const [itemElement, ...otherItems] = listedItems(listElement)
    expect(otherItems).toEqual([])
    expect(itemElement?.tagName).toBe('LI')
    expect(slotOf(itemElement, 'name').textContent).toBe('cv.pdf')
    expect(slotOf(itemElement, 'size').textContent).toBe('2 KB')
    expect(slotOf(itemElement, 'problem').hidden).toBe(true)
    expect(slotOf(itemElement, 'remove').textContent).toBe('Remove')
    expect(itemElement?.hasAttribute('data-astro-form-file-state')).toBe(false)
    expect(listElement?.querySelector('template')).not.toBeNull()
  })

  it('adds a second pick to the first, dropping an identical file but keeping a different one of the same name', () => {
    const { inputElement, listElement } = mountForm()

    pick(inputElement, [pdf('cv.pdf', 2048)])
    pick(inputElement, [pdf('cv.pdf', 2048), pdf('cover-letter.pdf', 512)])
    expect(listedNames(listElement)).toEqual(['cv.pdf', 'cover-letter.pdf'])

    pick(inputElement, [pdf('cv.pdf', 4096, 1_700_000_500_000)])
    expect(listedNames(listElement)).toEqual(['cv.pdf', 'cover-letter.pdf', 'cv.pdf'])
    expect(listedItems(listElement).map((itemElement) => slotOf(itemElement, 'size').textContent)).toEqual([
      '2 KB',
      '512 B',
      '4 KB'
    ])
    expect(inputNames(inputElement)).toEqual(['cv.pdf', 'cover-letter.pdf', 'cv.pdf'])
  })

  it('removes a file and updates the input the form submits', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { inputElement, listElement, statusElement, submit } = mountForm()
    pick(inputElement, [pdf('cv.pdf', 2048), pdf('cover-letter.pdf', 512)])

    slotOf(listedItems(listElement)[0], 'remove').click()

    expect(listedNames(listElement)).toEqual(['cover-letter.pdf'])
    expect(inputNames(inputElement)).toEqual(['cover-letter.pdf'])
    expect(document.activeElement).toBe(slotOf(listedItems(listElement)[0], 'remove'))

    submit()
    await vi.waitFor(() => expect(statusElement.dataset.astroFormState).toBe('success'))
    expect(postedNames(fetchSpy)).toEqual(['cover-letter.pdf'])
  })

  it("flags a file over the count, size, total or type with the site's message and placeholders filled", () => {
    const { inputElement, listElement } = mountForm({
      inputAttributes: `multiple accept="application/pdf,.pdf"
        data-astro-form-max-files="3" data-astro-form-max-file-bytes="1024" data-astro-form-max-total-bytes="2048"
        data-astro-form-message-too-many-files="Choose up to {maxFiles} files."
        data-astro-form-message-file-too-large="Keep each file under {maxFileSize}."
        data-astro-form-message-files-too-large="Keep the files under {maxTotalSize} together."
        data-astro-form-message-file-type="Only {types}, please."`
    })

    pick(inputElement, [
      pdf('a.pdf', 1000),
      new File([new Uint8Array(100)], 'b.png', { type: 'image/png' }),
      pdf('c.pdf', 2000),
      pdf('d.pdf', 1000),
      pdf('e.pdf', 100),
      pdf('f.pdf', 10),
      pdf('g.pdf', 10)
    ])

    const itemElements = listedItems(listElement)
    expect(itemElements.map((itemElement) => slotOf(itemElement, 'problem').textContent)).toEqual([
      '',
      'Only PDF, please.',
      'Keep each file under 1 KB.',
      '',
      'Keep the files under 2 KB together.',
      '',
      'Choose up to 3 files.'
    ])
    expect(itemElements.map((itemElement) => itemElement.dataset.astroFormFileState ?? null)).toEqual([
      null,
      'invalid',
      'invalid',
      null,
      'invalid',
      null,
      'invalid'
    ])
    expect(itemElements.map((itemElement) => slotOf(itemElement, 'problem').hidden)).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
      false
    ])
  })

  it('lets a file with no browser type or an upper-case extension through', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { inputElement, listElement, statusElement, submit } = mountForm({
      inputAttributes: 'multiple accept="image/jpeg,image/heic,.jpg,.heic,.pdf" data-astro-form-max-files="3"'
    })

    // The server checks every file's bytes; the browser's check only spares the person a wasted send.
    pick(inputElement, [
      new File([new Uint8Array(100)], 'IMG_0001.HEIF', { type: '' }),
      new File([new Uint8Array(100)], 'SCAN.PDF', { type: 'application/x-scanned' })
    ])

    expect(listedItems(listElement).map((itemElement) => itemElement.dataset.astroFormFileState ?? null)).toEqual([
      null,
      null
    ])

    submit()
    await vi.waitFor(() => expect(statusElement.dataset.astroFormState).toBe('success'))
    expect(postedNames(fetchSpy)).toEqual(['IMG_0001.HEIF', 'SCAN.PDF'])
  })

  it('blocks submission while a file has a problem and focuses its remove control', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { inputElement, listElement, statusElement, summaryElement, submit } = mountForm({
      inputAttributes: 'multiple accept="image/jpeg,image/png,.jpg,.jpeg,.png" data-astro-form-max-files="3"'
    })
    pick(inputElement, [
      new File([new Uint8Array(100)], 'kitchen.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array(100)], 'notes.txt', { type: 'text/plain' })
    ])

    expect(submit()).toBe(false)
    await settle()

    const typeMessage = 'That file type is not accepted. Please attach JPG, JPEG or PNG.'
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(slotOf(listedItems(listElement)[1], 'remove'))
    expect(inputElement.getAttribute('aria-invalid')).toBe('true')
    expect(listElement?.dataset.astroFormInvalid).toBe('true')
    expect(summaryElement.hidden).toBe(false)
    expect(Array.from(summaryElement.querySelectorAll('li'), (itemElement) => itemElement.textContent)).toEqual([
      typeMessage
    ])
    expect(slotOf(listedItems(listElement)[1], 'problem').textContent).toBe(typeMessage)

    slotOf(listedItems(listElement)[1], 'remove').click()
    await settle()

    expect(inputElement.hasAttribute('aria-invalid')).toBe(false)
    expect(listElement?.hasAttribute('data-astro-form-invalid')).toBe(false)
    expect(summaryElement.hidden).toBe(true)
    expect(document.activeElement).toBe(slotOf(listedItems(listElement)[0], 'remove'))

    submit()
    await vi.waitFor(() => expect(statusElement.dataset.astroFormState).toBe('success'))
    expect(postedNames(fetchSpy)).toEqual(['kitchen.jpg'])
  })

  it('keeps the files after a refused submission and clears them after success or reset', async () => {
    const fetchSpy = stubFetch(async () =>
      fetchSpy.mock.calls.length === 1
        ? jsonResponse(
            { error: 'Please correct the highlighted fields.', fieldErrors: { name: 'Enter your name.' } },
            400
          )
        : jsonResponse({ ok: true })
    )
    const { formElement, inputElement, listElement, statusElement, submit } = mountForm()
    pick(inputElement, [pdf('cv.pdf', 2048), pdf('cover-letter.pdf', 512)])

    submit()
    await vi.waitFor(() => expect(statusElement.dataset.astroFormState).toBe('error'))
    expect(listedNames(listElement)).toEqual(['cv.pdf', 'cover-letter.pdf'])
    expect(inputNames(inputElement)).toEqual(['cv.pdf', 'cover-letter.pdf'])

    submit()
    await vi.waitFor(() => expect(statusElement.dataset.astroFormState).toBe('success'))
    expect(postedNames(fetchSpy, 1)).toEqual(['cv.pdf', 'cover-letter.pdf'])
    expect(listedItems(listElement)).toEqual([])
    expect(inputNames(inputElement)).toEqual([])

    pick(inputElement, [pdf('cv.pdf', 2048)])
    formElement.reset()
    expect(listedItems(listElement)).toEqual([])
    expect(inputNames(inputElement)).toEqual([])
  })

  it('clears the selection when the field is disabled', async () => {
    const { inputElement, listElement } = mountForm()
    pick(inputElement, [pdf('cv.pdf', 2048)])

    inputElement.disabled = true
    await settle()

    expect(listedItems(listElement)).toEqual([])
    expect(inputNames(inputElement)).toEqual([])
  })

  it('a single-file field replaces its file on a new pick', () => {
    const { inputElement, listElement } = mountForm({
      inputAttributes: 'accept="application/pdf,.pdf" data-astro-form-max-files="1"'
    })

    pick(inputElement, [pdf('cv.pdf', 2048)])
    pick(inputElement, [pdf('cv-updated.pdf', 4096)])

    expect(listedNames(listElement)).toEqual(['cv-updated.pdf'])
    expect(inputNames(inputElement)).toEqual(['cv-updated.pdf'])
  })

  it('shows a filename containing markup or right-to-left text literally', () => {
    const { inputElement, listElement } = mountForm()
    const markupName = '<img src=x onerror=alert(1)>.pdf'
    const rightToLeftName = 'سيرة ذاتية.pdf'

    pick(inputElement, [pdf(markupName, 100), pdf(rightToLeftName, 200)])

    expect(listedNames(listElement)).toEqual([markupName, rightToLeftName])
    expect(listElement?.querySelector('img')).toBeNull()
    expect(slotOf(listedItems(listElement)[1], 'name').getAttribute('dir')).toBe('auto')
  })

  it('two forms with a cv field keep separate lists', () => {
    document.body.innerHTML = formMarkup({ id: 'application' }) + formMarkup({ id: 'referral' })
    initializeForms()
    const application = partsOf(document.querySelector<HTMLFormElement>('#application'))
    const referral = partsOf(document.querySelector<HTMLFormElement>('#referral'))

    pick(application.inputElement, [pdf('cv.pdf', 2048)])
    expect(listedNames(application.listElement)).toEqual(['cv.pdf'])
    expect(listedItems(referral.listElement)).toEqual([])

    pick(referral.inputElement, [pdf('referee-cv.pdf', 1024)])
    expect(listedNames(application.listElement)).toEqual(['cv.pdf'])
    expect(listedNames(referral.listElement)).toEqual(['referee-cv.pdf'])
  })

  it('a required file field left empty is flagged on submit with the fileRequired message and not sent', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { formElement, inputElement, submit } = mountForm({
      inputAttributes: 'required accept="application/pdf,.pdf" data-astro-form-max-files="1"',
      slot: true
    })

    expect(submit()).toBe(false)
    await settle()

    const slotElement = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-for="cv"]')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(inputElement)
    expect(inputElement.getAttribute('aria-invalid')).toBe('true')
    expect(inputElement.getAttribute('aria-describedby')).toBe('application-cv-error')
    expect(slotElement?.textContent).toBe('Please attach a file.')
    expect(slotElement?.hidden).toBe(false)
  })

  it('without the list markup, the input is left as the browser provides it', async () => {
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    const { inputElement, statusElement, submit } = mountForm({ list: false })

    pick(inputElement, [pdf('cv.pdf', 2048)])
    pick(inputElement, [new File([new Uint8Array(100)], 'photo.png', { type: 'image/png' })])
    expect(inputNames(inputElement)).toEqual(['photo.png'])

    submit()
    await vi.waitFor(() => expect(statusElement.dataset.astroFormState).toBe('success'))
    expect(postedNames(fetchSpy)).toEqual(['photo.png'])
  })

  it('a file list with no template is reported, and the form still sends', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = stubFetch(async () => jsonResponse({ ok: true }))
    document.body.innerHTML = formMarkup().replace(ITEM_TEMPLATE, '')
    initializeForms()
    const { inputElement, statusElement, submit } = partsOf(document.querySelector('form'))

    expect(error).toHaveBeenCalledWith(expect.stringContaining('FileFieldController'), expect.any(Error))

    pick(inputElement, [pdf('cv.pdf', 2048)])
    submit()
    await vi.waitFor(() => expect(statusElement.dataset.astroFormState).toBe('success'))
    expect(postedNames(fetchSpy)).toEqual(['cv.pdf'])
  })
})

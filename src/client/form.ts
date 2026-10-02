/**
 * Progressive-enhancement submit handling for a form the site owns entirely.
 *
 * The package ships no markup: you write your own `<form>` (and its honeypot input, status element,
 * and any Turnstile container), mark it with the data attributes below, and call
 * {@link initializeForms} to enhance it. The markup is yours, so ordinary scoped styles reach it; the
 * only contract is the `data-astro-form-*` hooks, which are behavioural, not styling handles.
 *
 * Import it from a `<script>` on the page and re-run it on Astro View Transitions:
 *
 * ```ts
 * import { initializeForms } from '@nialto-services/astro-form-submissions/form'
 * initializeForms()
 * document.addEventListener('astro:page-load', initializeForms)
 * ```
 *
 * ## The contract
 *
 * - `[data-astro-form]` — the `<form>` to enhance (required).
 * - `[data-astro-form-status]` — a live-region element inside the form for status copy (required).
 *   Carries the copy as `data-astro-form-message-{sending,success,generic-error,network-error}`, and
 *   receives `data-astro-form-state` of `pending` / `success` / `error` while submitting.
 * - `[data-astro-form-success]` — an optional element immediately after the form; when present, a
 *   successful submission swaps the whole `<form>` out for it (and focuses it).
 * - `[data-astro-form-field-error-for="<name>"]` — an optional co-located slot the script fills with
 *   that field's message and links via `aria-describedby`.
 * - `[data-astro-form-field-error-summary]` — an optional element the script fills with a list of
 *   every field's message, each linking to its field.
 * - `data-astro-form-submit-timeout` — optional per-form request timeout override, in milliseconds
 *   (a non-positive or non-finite value is ignored in favour of the default). A direct upload uses it as
 *   an idle deadline: it fails once that long passes with no progress.
 * - `.cf-turnstile` — an optional Turnstile widget container (Cloudflare's own convention); the
 *   script refreshes it after each attempt so a retry never resubmits a spent token.
 *
 * ## Direct uploads (opt-in)
 *
 * - `data-astro-form-upload-action` on the `<form>` — the upload route (see `createUploadRoute`). With it,
 *   file inputs marked `data-astro-form-upload` never join a submission; when any of them holds files, a
 *   submit first asks the upload route where to send each one, uploads them with progress, refreshes
 *   Turnstile, then posts the form with one receipt per file.
 * - `data-astro-form-upload-field` on the `<form>` — the field the file descriptors are posted to the upload
 *   route under. Default `uploads`, matching `createUploadRoute`'s `field`.
 * - `data-astro-form-upload-receipt-field` on the `<form>` — the field the receipts are posted under.
 *   Default `upload`, matching the `UploadedFiles` enricher.
 * - `data-astro-form-message-uploading` on the status element — the copy shown while files upload, with
 *   `{current}`, `{total}` and `{percent}` filled in.
 * - `astro-form:upload-progress` — emitted on the form as bytes go up, with
 *   `{ current, total, loaded, size, percent }`.
 */

// MARK: - Configuration

// Browsers provide no application deadline of their own: a stalled connection would otherwise
// leave the form pending for the page lifetime. Override per form via `data-astro-form-submit-timeout` (ms).
const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000

// A refreshed Turnstile widget usually issues a new token within a second or two; past this, the
// submission goes ahead and the server's verification error explains the failure.
const TURNSTILE_TOKEN_TIMEOUT_MS = 30_000
const TURNSTILE_POLL_INTERVAL_MS = 100

const DEFAULT_DESCRIPTOR_FIELD = 'uploads'
const DEFAULT_RECEIPT_FIELD = 'upload'

// MARK: - Response parsing

/** Parse a response body as JSON, treating any malformed payload as "no result". */
function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Narrow an unknown value to a plain non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Pull the per-field messages out of an error body, keeping only string values keyed by field name. */
function readFieldErrors(result: unknown): Record<string, string> {
  const fieldErrors: Record<string, string> = {}
  if (isRecord(result) && isRecord(result.fieldErrors)) {
    for (const [name, message] of Object.entries(result.fieldErrors)) {
      if (typeof message === 'string') fieldErrors[name] = message
    }
  }
  return fieldErrors
}

// MARK: - Field-error presentation

// Marks an input whose `aria-describedby` the script itself added, so it can remove exactly that on
// clear without disturbing an author-authored value.
const DESCRIBED_MARKER = 'astroFormDescribed'

/** Drop the `aria-describedby` the script added to an input (leaving any author-set value intact). */
function clearDescribedBy(inputElement: HTMLElement): void {
  if (inputElement.dataset[DESCRIBED_MARKER] === undefined) return

  inputElement.removeAttribute('aria-describedby')
  delete inputElement.dataset[DESCRIBED_MARKER]
}

/**
 * Mark each faulty field `aria-invalid` and, where a co-located `[data-astro-form-field-error-for]` slot
 * sits beside it, fill that slot and link it via `aria-describedby` (read on focus, so it is deliberately
 * not a live region — the summary already announces). Returns the first invalid input, for focus.
 */
function applyFieldErrors(formElement: HTMLFormElement, fieldErrors: Record<string, string>): HTMLElement | null {
  let firstInvalidElement: HTMLElement | null = null
  for (const [name, message] of Object.entries(fieldErrors)) {
    const inputElement = formElement.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`)
    if (!inputElement) continue

    inputElement.setAttribute('aria-invalid', 'true')
    firstInvalidElement ??= inputElement

    const slotElement = formElement.querySelector<HTMLElement>(
      `[data-astro-form-field-error-for="${CSS.escape(name)}"]`
    )
    if (!slotElement) continue

    slotElement.textContent = message
    slotElement.hidden = false
    if (slotElement.id && !inputElement.getAttribute('aria-describedby')) {
      inputElement.setAttribute('aria-describedby', slotElement.id)
      inputElement.dataset[DESCRIBED_MARKER] = ''
    }
  }
  return firstInvalidElement
}

/**
 * Fill the central `[data-astro-form-field-error-summary]` element with a list of every field's message,
 * each linking to its field. Returns the summary to focus, or `null` when the markup provides none.
 */
function renderFieldErrorSummary(
  formElement: HTMLFormElement,
  fieldErrors: Record<string, string>
): HTMLElement | null {
  const summaryElement = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
  if (!summaryElement) return null

  summaryElement.textContent = ''
  const entries = Object.entries(fieldErrors)
  if (entries.length === 0) {
    summaryElement.hidden = true
    return null
  }

  const listElement = document.createElement('ul')
  for (const [name, message] of entries) {
    const itemElement = document.createElement('li')

    // Tag the item with its field so progressive recovery can remove exactly this entry on input.
    itemElement.dataset.astroFormSummaryItem = name
    const inputElement = formElement.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`)
    if (inputElement) {
      const linkElement = document.createElement('a')
      if (inputElement.id) linkElement.href = `#${inputElement.id}`
      linkElement.textContent = message
      linkElement.addEventListener('click', (event) => {
        event.preventDefault()
        inputElement.focus()
      })
      itemElement.append(linkElement)
    } else {
      itemElement.textContent = message
    }
    listElement.append(itemElement)
  }
  summaryElement.append(listElement)
  summaryElement.hidden = false

  // A non-interactive container needs a tabindex to receive the programmatic focus below; a
  // site-supplied one is left alone so a real tabstop isn't clobbered.
  if (!summaryElement.hasAttribute('tabindex')) summaryElement.setAttribute('tabindex', '-1')
  return summaryElement
}

/** Clear every field's invalid state, empty its slot, and empty the summary list — on resubmit. */
function clearFieldErrors(formElement: HTMLFormElement): void {
  for (const inputElement of formElement.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    inputElement.removeAttribute('aria-invalid')
    clearDescribedBy(inputElement)
  }
  for (const slotElement of formElement.querySelectorAll<HTMLElement>('[data-astro-form-field-error-for]')) {
    slotElement.textContent = ''
    slotElement.hidden = true
  }
  const summaryElement = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
  if (summaryElement) {
    summaryElement.textContent = ''
    summaryElement.hidden = true
  }
}

// MARK: - Turnstile

/**
 * Best-effort refresh of this form's Turnstile widget (bare `turnstile.reset()` would reset every
 * widget on the page). The `turnstile` global is injected by the consuming page's widget loader;
 * it being absent or throwing must never affect form state.
 */
function resetTurnstileWidget(formElement: HTMLFormElement): void {
  try {
    const turnstile = (window as { turnstile?: { reset(widgetElement?: string | Element | null): void } }).turnstile
    const widgetElement = formElement.querySelector('.cf-turnstile')
    if (widgetElement) turnstile?.reset(widgetElement)
  } catch {
    /* optional integration — see above */
  }
}

/** The hidden response inputs this form's Turnstile widgets render, whatever their `data-response-field-name`. */
function turnstileTokenInputs(formElement: HTMLFormElement): HTMLInputElement[] {
  return Array.from(formElement.querySelectorAll<HTMLInputElement>('.cf-turnstile input[type="hidden"]'))
}

/**
 * Resolves once every Turnstile widget in this form holds a token, or after
 * {@link TURNSTILE_TOKEN_TIMEOUT_MS}. Resolves at once for a form without a widget. Reads the hidden
 * response inputs the widgets render.
 */
function waitForTurnstileToken(formElement: HTMLFormElement): Promise<void> {
  if (!formElement.querySelector('.cf-turnstile')) return Promise.resolve()

  const deadline = Date.now() + TURNSTILE_TOKEN_TIMEOUT_MS
  return new Promise((resolve) => {
    const poll = () => {
      const tokenInputElements = turnstileTokenInputs(formElement)
      const issued =
        tokenInputElements.length > 0 && tokenInputElements.every((tokenInputElement) => tokenInputElement.value !== '')
      if (issued || Date.now() >= deadline) {
        resolve()
        return
      }

      setTimeout(poll, TURNSTILE_POLL_INTERVAL_MS)
    }
    poll()
  })
}

// MARK: - Direct uploads

/** Where and how to upload one file, and the receipt proving it was admitted, as the upload route grants them. */
interface GrantedUpload {
  url: string
  method: string
  headers: Record<string, string>
  receipt: string
}

/** Narrow the upload route's `uploads` list, or `null` when any entry is malformed. */
function readGrantedUploads(result: unknown): GrantedUpload[] | null {
  if (!isRecord(result) || !Array.isArray(result.uploads)) return null

  const uploads: GrantedUpload[] = []
  for (const entry of result.uploads) {
    if (!isRecord(entry) || typeof entry.url !== 'string' || typeof entry.method !== 'string') return null
    if (typeof entry.receipt !== 'string' || !isRecord(entry.headers)) return null

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(entry.headers)) {
      if (typeof value === 'string') headers[name] = value
    }
    uploads.push({ url: entry.url, method: entry.method, headers, receipt: entry.receipt })
  }
  return uploads
}

/** The file inputs whose files upload directly, rather than joining the submission. */
function uploadInputs(formElement: HTMLFormElement): HTMLInputElement[] {
  return Array.from(formElement.querySelectorAll<HTMLInputElement>('input[type="file"][data-astro-form-upload]'))
}

/** The form's data without any directly-uploaded file input. */
function formDataWithoutUploads(formElement: HTMLFormElement, submitter: HTMLElement | null): FormData {
  const formData = submitter ? new FormData(formElement, submitter) : new FormData(formElement)
  for (const inputElement of uploadInputs(formElement)) {
    if (inputElement.name) formData.delete(inputElement.name)
  }
  return formData
}

/**
 * Upload one file as instructed, reporting bytes sent as they go. Resolves `true` on a 2xx response and
 * `false` on any other status, a network failure, or `idleTimeoutMs` passing with no progress (a stalled
 * connection otherwise holds the form pending until the OS gives up). `XMLHttpRequest`, because `fetch`
 * reports no upload progress.
 */
function uploadFile(
  upload: GrantedUpload,
  file: File,
  idleTimeoutMs: number,
  onProgress: (loaded: number) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest()
    let idleTimer: ReturnType<typeof setTimeout> | undefined

    // An idle deadline rather than a total one, so a large upload on a slow but moving link still finishes.
    const restartIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => request.abort(), idleTimeoutMs)
    }

    const finish = (stored: boolean) => {
      clearTimeout(idleTimer)
      resolve(stored)
    }

    request.open(upload.method, upload.url)
    for (const [name, value] of Object.entries(upload.headers)) request.setRequestHeader(name, value)

    request.upload.addEventListener('progress', (event) => {
      restartIdleTimer()
      if (event.lengthComputable) onProgress(event.loaded)
    })
    request.addEventListener('load', () => finish(request.status >= 200 && request.status < 300))
    request.addEventListener('error', () => finish(false))
    request.addEventListener('abort', () => finish(false))
    request.send(file)
    restartIdleTimer()
  })
}

/** Fill the uploading copy's `{current}`, `{total}` and `{percent}` placeholders. */
function formatUploadingMessage(template: string, current: number, total: number, percent: number): string {
  return template
    .replaceAll('{current}', String(current))
    .replaceAll('{total}', String(total))
    .replaceAll('{percent}', String(percent))
}

// MARK: - Form enhancement

/** The per-form elements and copy resolved once at enhancement time and shared by both handlers. */
interface FormBinding {
  formElement: HTMLFormElement
  statusElement: HTMLElement
  successElement: HTMLElement | null
  messages: {
    sending?: string
    uploading?: string
    success?: string
    genericError?: string
    networkError?: string
  }
}

/** Resolve the per-form request timeout, keeping the default for a non-positive or non-finite override. */
function resolveSubmitTimeout(formElement: HTMLFormElement): number {
  // A negative or non-finite override would clamp to an immediate abort, so anything but a finite
  // positive number falls back to the default rather than breaking submission.
  const configured = Number(formElement.dataset.astroFormSubmitTimeout)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SUBMIT_TIMEOUT_MS
}

/**
 * The URL a native submission would go to: the submitter's `formaction` when it has one, else the form's
 * `action` attribute, else the document. Read from the attribute because a control named `action`
 * shadows `formElement.action`.
 */
function resolveSubmissionURL(formElement: HTMLFormElement, submitter: HTMLButtonElement | HTMLInputElement | null) {
  if (submitter?.hasAttribute('formaction')) return submitter.formAction

  const action = formElement.getAttribute('action')
  return action ? new URL(action, document.baseURI).href : document.URL
}

/**
 * POST the form data and read the JSON body. Resolves `null` when the request never completes (network
 * failure or timeout abort) — the caller's network-error signal; otherwise `{ response, result }` to check
 * against the `{ ok: true }` contract. Only acquisition is caught, so a later presentation failure is never
 * misread as a delivery failure.
 */
async function sendRequest(
  url: string,
  formData: FormData,
  timeoutMs: number
): Promise<{ response: Response; result: unknown } | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json'
      },
      body: formData,
      signal: controller.signal
    })
    return { response, result: parseJSON(await response.text()) }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Present a rejection: set the error status, mark and annotate the faulty fields, refresh Turnstile, and emit `astro-form:error`. */
function showError(binding: FormBinding, error: string, fieldErrors: Record<string, string> = {}): void {
  const { formElement, statusElement } = binding
  statusElement.textContent = error
  statusElement.dataset.astroFormState = 'error'
  const firstInvalidElement = applyFieldErrors(formElement, fieldErrors)
  const summaryElement = renderFieldErrorSummary(formElement, fieldErrors)

  // Prefer the summary list for the multi-error overview; otherwise land the user on the first
  // field to fix.
  ;(summaryElement ?? firstInvalidElement)?.focus()

  // The server consumes the Turnstile token before dispatching, so the widget must refresh
  // after any attempt — otherwise a retry resubmits a spent token, rejected as a duplicate.
  resetTurnstileWidget(formElement)
  formElement.dispatchEvent(new CustomEvent('astro-form:error', { bubbles: true, detail: { error, fieldErrors } }))
}

/**
 * Present a confirmed success: swap the form out for the `[data-astro-form-success]` panel when one follows
 * it, otherwise show the success copy and reset. Best-effort — a failing swap, focus, or reset must not
 * re-enter the error path and invite a duplicate send.
 */
function showSuccess(binding: FormBinding): void {
  const { formElement, statusElement, successElement, messages } = binding
  try {
    if (successElement) {
      successElement.hidden = false
      formElement.replaceWith(successElement)

      // The status live-region left with the form; focusing the panel announces it instead.
      successElement.focus()
    } else {
      statusElement.textContent = messages.success ?? ''
      statusElement.dataset.astroFormState = 'success'

      // Called through the prototype because a control named `reset` shadows `formElement.reset`.
      HTMLFormElement.prototype.reset.call(formElement)
      resetTurnstileWidget(formElement)
    }
  } catch {
    /* best-effort presentation — see above */
  }
}

/**
 * Drop a field's invalid mark, inline message, and summary entry as soon as the user edits it, so the
 * error state tracks what they're fixing rather than persisting until the next submit.
 */
function bindProgressiveRecovery(formElement: HTMLFormElement): void {
  formElement.addEventListener('input', (event) => {
    const targetElement = event.target instanceof HTMLElement ? event.target : null
    const name = targetElement?.getAttribute('name')
    if (!name || targetElement?.getAttribute('aria-invalid') !== 'true') return

    targetElement.removeAttribute('aria-invalid')
    clearDescribedBy(targetElement)
    const slotElement = formElement.querySelector<HTMLElement>(
      `[data-astro-form-field-error-for="${CSS.escape(name)}"]`
    )
    if (slotElement) {
      slotElement.textContent = ''
      slotElement.hidden = true
    }

    // Drop this field's entry from the central summary too, and hide the summary once its last entry
    // goes — otherwise a corrected field keeps claiming it's invalid in the overview and to AT.
    const summaryElement = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
    if (summaryElement) {
      summaryElement.querySelector(`[data-astro-form-summary-item="${CSS.escape(name)}"]`)?.remove()
      if (!summaryElement.querySelector('[data-astro-form-summary-item]')) {
        summaryElement.textContent = ''
        summaryElement.hidden = true
      }
    }
  })
}

/** What a POST to the form's endpoints came to: its parsed `{ ok: true }` body, or the error to present. */
type PostOutcome =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: string; fieldErrors?: Record<string, string> }

/**
 * POST form data and interpret the reply against the `{ ok: true }` contract: success, the server's error
 * and field errors, or the network-error copy when no reply arrived.
 */
async function postForm(binding: FormBinding, url: string, formData: FormData): Promise<PostOutcome> {
  const { formElement, messages } = binding
  const request = await sendRequest(url, formData, resolveSubmitTimeout(formElement))
  if (!request) return { ok: false, error: messages.networkError ?? '' }

  // Success is the documented `{ ok: true }` contract — any other parseable 2xx body
  // (a proxy page, misrouting, a future endpoint) must not trigger the success UI.
  const { response, result } = request
  if (!(response.ok && isRecord(result) && result.ok === true)) {
    const serverError = isRecord(result) && typeof result.error === 'string' ? result.error : ''
    return { ok: false, error: serverError || messages.genericError || '', fieldErrors: readFieldErrors(result) }
  }

  return { ok: true, result }
}

/**
 * The three-step submission for a form with direct uploads: ask the upload route where each file goes,
 * upload them with progress, then post the form with a receipt per file. Every step's failure ends the
 * attempt; a retry starts again from the first step, since the server deletes a refused submission's files.
 */
async function submitWithUploads(
  binding: FormBinding,
  uploadAction: string,
  submissionURL: string,
  formData: FormData,
  files: File[]
): Promise<PostOutcome & { formData?: FormData }> {
  const { formElement, statusElement, messages } = binding

  const uploadRequest = new FormData()
  for (const [name, value] of formData) uploadRequest.append(name, value)
  uploadRequest.set(
    formElement.dataset.astroFormUploadField || DEFAULT_DESCRIPTOR_FIELD,
    JSON.stringify(files.map((file) => ({ name: file.name, size: file.size, type: file.type })))
  )

  const admission = await postForm(binding, uploadAction, uploadRequest)
  if (!admission.ok) return admission

  // A dropped or quarantined request is granted nothing, and the form route meets the same verdict, so
  // the submission goes ahead without its files rather than revealing the difference.
  const granted = readGrantedUploads(admission.result)
  if (!granted || (granted.length > 0 && granted.length !== files.length)) {
    return { ok: false, error: messages.genericError ?? '' }
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  let bytesBefore = 0
  for (const [index, upload] of granted.entries()) {
    const file = files[index]
    if (!file) break

    const onProgress = (loaded: number) => {
      const percent = totalBytes > 0 ? Math.min(100, Math.floor(((bytesBefore + loaded) * 100) / totalBytes)) : 100
      if (messages.uploading) {
        statusElement.textContent = formatUploadingMessage(messages.uploading, index + 1, granted.length, percent)
      }

      formElement.dispatchEvent(
        new CustomEvent('astro-form:upload-progress', {
          bubbles: true,
          detail: { current: index + 1, total: granted.length, loaded, size: file.size, percent }
        })
      )
    }

    onProgress(0)
    const stored = await uploadFile(upload, file, resolveSubmitTimeout(formElement), onProgress)
    if (!stored) return { ok: false, error: messages.networkError ?? '' }

    bytesBefore += file.size
  }

  statusElement.textContent = messages.sending ?? ''

  // The upload route spent the Turnstile token, so the form route needs a fresh one.
  resetTurnstileWidget(formElement)
  await waitForTurnstileToken(formElement)

  const finalData = new FormData()
  for (const [name, value] of formData) finalData.append(name, value)
  for (const tokenInputElement of turnstileTokenInputs(formElement)) {
    if (tokenInputElement.name) finalData.set(tokenInputElement.name, tokenInputElement.value)
  }

  const receiptField = formElement.dataset.astroFormUploadReceiptField || DEFAULT_RECEIPT_FIELD
  for (const upload of granted) finalData.append(receiptField, upload.receipt)

  const outcome = await postForm(binding, submissionURL, finalData)
  return outcome.ok ? { ...outcome, formData: finalData } : outcome
}

/** Handle a submit: guard re-entry, POST via `fetch`, and route the outcome to success or error presentation. */
async function submitForm(binding: FormBinding, event: SubmitEvent): Promise<void> {
  const { formElement, statusElement, messages } = binding
  event.preventDefault()

  // Guard overlapping submissions (rapid Enter/click) beyond any disabled control.
  if (formElement.dataset.astroFormSubmitting) return

  // The control that actually triggered submission (click, Enter, `requestSubmit(control)`).
  // Standard HTML semantics: its name/value joins the payload and it is the one disabled.
  const submitter =
    event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement ? event.submitter : null

  // Direct-upload inputs never join a submission; their files go up in steps of their own. Empty files
  // are skipped, as `FileUploads` skips them on the multipart path, since the upload route refuses them.
  const uploadAction = formElement.dataset.astroFormUploadAction
  const files = uploadAction
    ? uploadInputs(formElement)
        .flatMap((inputElement) => Array.from(inputElement.files ?? []))
        .filter((file) => file.size > 0)
    : []

  // A disabled control is omitted from FormData, so the submitter must still be enabled here.
  const formData = uploadAction
    ? formDataWithoutUploads(formElement, submitter)
    : submitter
      ? new FormData(formElement, submitter)
      : new FormData(formElement)

  formElement.dataset.astroFormSubmitting = 'true'
  if (submitter) submitter.disabled = true

  // Wipe prior field marks so a field fixed since the last submit isn't left flagged.
  clearFieldErrors(formElement)
  statusElement.textContent = messages.sending ?? ''
  statusElement.dataset.astroFormState = 'pending'

  const submissionURL = resolveSubmissionURL(formElement, submitter)
  let outcome: PostOutcome & { formData?: FormData }
  try {
    outcome =
      uploadAction && files.length > 0
        ? await submitWithUploads(binding, uploadAction, submissionURL, formData, files)
        : await postForm(binding, submissionURL, formData)
  } finally {
    if (submitter) submitter.disabled = false
    delete formElement.dataset.astroFormSubmitting
  }

  if (!outcome.ok) {
    showError(binding, outcome.error, outcome.fieldErrors)
    return
  }

  // Dispatched before any swap so the form is still in the document for listeners.
  formElement.dispatchEvent(
    new CustomEvent('astro-form:success', { bubbles: true, detail: { data: outcome.formData ?? formData } })
  )
  showSuccess(binding)
}

/**
 * Resolve one form's status/success elements and copy, set the accessibility defaults, and bind its input
 * and submit handlers. Returns without marking the form bound when the required `[data-astro-form-status]`
 * element is absent, so a later call retries it.
 */
function enhanceForm(formElement: HTMLFormElement): void {
  const statusElement = formElement.querySelector<HTMLElement>('[data-astro-form-status]')
  if (!statusElement) return

  // An element carrying `data-astro-form-success` immediately after the form is the (hidden) panel a
  // successful submission swaps the whole <form> out for.
  const siblingElement = formElement.nextElementSibling
  const successElement =
    siblingElement instanceof HTMLElement && siblingElement.hasAttribute('data-astro-form-success')
      ? siblingElement
      : null

  // Announce status changes to assistive tech even if the site markup omits the attributes.
  if (!statusElement.hasAttribute('role')) statusElement.setAttribute('role', 'status')
  if (!statusElement.hasAttribute('aria-live')) statusElement.setAttribute('aria-live', 'polite')

  const {
    astroFormMessageSending: sending,
    astroFormMessageUploading: uploading,
    astroFormMessageSuccess: success,
    astroFormMessageGenericError: genericError,
    astroFormMessageNetworkError: networkError
  } = statusElement.dataset

  formElement.dataset.astroFormBound = 'true'
  const binding: FormBinding = {
    formElement,
    statusElement,
    successElement,
    messages: { sending, uploading, success, genericError, networkError }
  }

  bindProgressiveRecovery(formElement)
  formElement.addEventListener('submit', (event) => void submitForm(binding, event))
}

/**
 * Binds the submit handler to every unbound `[data-astro-form]` form in the document.
 *
 * Safe to call repeatedly (e.g. after Astro View Transitions swap the DOM): already-bound
 * forms are skipped via a `data-astro-form-bound` marker.
 */
export function initializeForms(): void {
  for (const formElement of document.querySelectorAll<HTMLFormElement>('form[data-astro-form]')) {
    // `initializeForms` is re-invoked on every `astro:page-load` navigation; bind each form only once.
    if (formElement.dataset.astroFormBound) continue

    enhanceForm(formElement)
  }
}

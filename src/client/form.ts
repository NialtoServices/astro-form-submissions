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
 *   (a non-positive or non-finite value is ignored in favour of the default).
 * - `.cf-turnstile` — an optional Turnstile widget container (Cloudflare's own convention); the
 *   script refreshes it after each attempt so a retry never resubmits a spent token.
 */

// MARK: - Configuration

// Browsers provide no application deadline of their own: a stalled connection would otherwise
// leave the form pending for the page lifetime. Override per form via `data-astro-form-submit-timeout` (ms).
const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000

// MARK: - Response parsing

/** Parse a response body as JSON, treating any malformed payload as "no result". */
function parseJson(text: string): unknown {
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
function clearDescribedBy(input: HTMLElement): void {
  if (input.dataset[DESCRIBED_MARKER] === undefined) return

  input.removeAttribute('aria-describedby')
  delete input.dataset[DESCRIBED_MARKER]
}

/**
 * Mark each faulty field `aria-invalid` and, where a co-located `[data-astro-form-field-error-for]` slot
 * sits beside it, fill that slot and link it via `aria-describedby` (read on focus, so it is deliberately
 * not a live region — the summary already announces). Returns the first invalid input, for focus.
 */
function applyFieldErrors(formElement: HTMLFormElement, fieldErrors: Record<string, string>): HTMLElement | null {
  let firstInvalid: HTMLElement | null = null
  for (const [name, message] of Object.entries(fieldErrors)) {
    const input = formElement.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`)
    if (!input) continue

    input.setAttribute('aria-invalid', 'true')
    firstInvalid ??= input

    const slot = formElement.querySelector<HTMLElement>(`[data-astro-form-field-error-for="${CSS.escape(name)}"]`)
    if (!slot) continue

    slot.textContent = message
    slot.hidden = false
    if (slot.id && !input.getAttribute('aria-describedby')) {
      input.setAttribute('aria-describedby', slot.id)
      input.dataset[DESCRIBED_MARKER] = ''
    }
  }
  return firstInvalid
}

/**
 * Fill the central `[data-astro-form-field-error-summary]` element with a list of every field's message,
 * each linking to its field. Returns the summary to focus, or `null` when the markup provides none.
 */
function renderFieldErrorSummary(
  formElement: HTMLFormElement,
  fieldErrors: Record<string, string>
): HTMLElement | null {
  const summary = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
  if (!summary) return null

  summary.textContent = ''
  const entries = Object.entries(fieldErrors)
  if (entries.length === 0) {
    summary.hidden = true
    return null
  }

  const list = document.createElement('ul')
  for (const [name, message] of entries) {
    const item = document.createElement('li')

    // Tag the item with its field so progressive recovery can remove exactly this entry on input.
    item.dataset.astroFormSummaryItem = name
    const input = formElement.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`)
    if (input) {
      const link = document.createElement('a')
      if (input.id) link.href = `#${input.id}`
      link.textContent = message
      link.addEventListener('click', (event) => {
        event.preventDefault()
        input.focus()
      })
      item.append(link)
    } else {
      item.textContent = message
    }
    list.append(item)
  }
  summary.append(list)
  summary.hidden = false

  // A non-interactive container needs a tabindex to receive the programmatic focus below; a
  // site-supplied one is left alone so a real tabstop isn't clobbered.
  if (!summary.hasAttribute('tabindex')) summary.setAttribute('tabindex', '-1')
  return summary
}

/** Clear every field's invalid state, empty its slot, and empty the summary list — on resubmit. */
function clearFieldErrors(formElement: HTMLFormElement): void {
  for (const input of formElement.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    input.removeAttribute('aria-invalid')
    clearDescribedBy(input)
  }
  for (const slot of formElement.querySelectorAll<HTMLElement>('[data-astro-form-field-error-for]')) {
    slot.textContent = ''
    slot.hidden = true
  }
  const summary = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
  if (summary) {
    summary.textContent = ''
    summary.hidden = true
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
    const turnstile = (window as { turnstile?: { reset(widget?: string | Element | null): void } }).turnstile
    const widget = formElement.querySelector('.cf-turnstile')
    if (widget) turnstile?.reset(widget)
  } catch {
    /* optional integration — see above */
  }
}

// MARK: - Form enhancement

/** The per-form elements and copy resolved once at enhancement time and shared by both handlers. */
interface FormBinding {
  formElement: HTMLFormElement
  statusElement: HTMLElement
  successElement: HTMLElement | null
  messages: {
    sending?: string
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
 * POST the form data and read the JSON body. Resolves `null` when the request never completes (network
 * failure or timeout abort) — the caller's network-error signal; otherwise `{ response, result }` to check
 * against the `{ ok: true }` contract. Only acquisition is caught, so a later presentation failure is never
 * misread as a delivery failure.
 */
async function sendRequest(
  formElement: HTMLFormElement,
  formData: FormData,
  timeoutMs: number
): Promise<{ response: Response; result: unknown } | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(formElement.action, {
      method: 'POST',
      headers: {
        Accept: 'application/json'
      },
      body: formData,
      signal: controller.signal
    })
    return { response, result: parseJson(await response.text()) }
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
  const firstInvalid = applyFieldErrors(formElement, fieldErrors)
  const summary = renderFieldErrorSummary(formElement, fieldErrors)

  // Prefer the summary list for the multi-error overview; otherwise land the user on the first
  // field to fix.
  ;(summary ?? firstInvalid)?.focus()

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
      formElement.reset()
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
    const target = event.target instanceof HTMLElement ? event.target : null
    const name = target?.getAttribute('name')
    if (!name || target?.getAttribute('aria-invalid') !== 'true') return

    target.removeAttribute('aria-invalid')
    clearDescribedBy(target)
    const slot = formElement.querySelector<HTMLElement>(`[data-astro-form-field-error-for="${CSS.escape(name)}"]`)
    if (slot) {
      slot.textContent = ''
      slot.hidden = true
    }

    // Drop this field's entry from the central summary too, and hide the summary once its last entry
    // goes — otherwise a corrected field keeps claiming it's invalid in the overview and to AT.
    const summary = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
    if (summary) {
      summary.querySelector(`[data-astro-form-summary-item="${CSS.escape(name)}"]`)?.remove()
      if (!summary.querySelector('[data-astro-form-summary-item]')) {
        summary.textContent = ''
        summary.hidden = true
      }
    }
  })
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

  // A disabled control is omitted from FormData, so the submitter must still be enabled here.
  const formData = submitter ? new FormData(formElement, submitter) : new FormData(formElement)

  formElement.dataset.astroFormSubmitting = 'true'
  if (submitter) submitter.disabled = true

  // Wipe prior field marks so a field fixed since the last submit isn't left flagged.
  clearFieldErrors(formElement)
  statusElement.textContent = messages.sending ?? ''
  statusElement.dataset.astroFormState = 'pending'

  let request: { response: Response; result: unknown } | null
  try {
    request = await sendRequest(formElement, formData, resolveSubmitTimeout(formElement))
  } finally {
    if (submitter) submitter.disabled = false
    delete formElement.dataset.astroFormSubmitting
  }

  if (!request) {
    showError(binding, messages.networkError ?? '')
    return
  }

  // Success is the documented `{ ok: true }` contract — any other parseable 2xx body
  // (a proxy page, misrouting, a future endpoint) must not trigger the success UI.
  const { response, result } = request
  if (!(response.ok && isRecord(result) && result.ok === true)) {
    const serverError = isRecord(result) && typeof result.error === 'string' ? result.error : ''
    showError(binding, serverError || messages.genericError || '', readFieldErrors(result))
    return
  }

  // Dispatched before any swap so the form is still in the document for listeners.
  formElement.dispatchEvent(new CustomEvent('astro-form:success', { bubbles: true, detail: { data: formData } }))
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
  const sibling = formElement.nextElementSibling
  const successElement =
    sibling instanceof HTMLElement && sibling.hasAttribute('data-astro-form-success') ? sibling : null

  // Announce status changes to assistive tech even if the site markup omits the attributes.
  if (!statusElement.hasAttribute('role')) statusElement.setAttribute('role', 'status')
  if (!statusElement.hasAttribute('aria-live')) statusElement.setAttribute('aria-live', 'polite')

  const {
    astroFormMessageSending: sending,
    astroFormMessageSuccess: success,
    astroFormMessageGenericError: genericError,
    astroFormMessageNetworkError: networkError
  } = statusElement.dataset

  formElement.dataset.astroFormBound = 'true'
  const binding: FormBinding = {
    formElement,
    statusElement,
    successElement,
    messages: { sending, success, genericError, networkError }
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

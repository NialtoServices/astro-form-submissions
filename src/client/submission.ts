// MARK: - Configuration

/**
 * Browsers provide no application deadline of their own: a stalled connection would otherwise
 * leave the form pending for the page lifetime. Override per form via `data-astro-form-submit-timeout` (ms).
 */
const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000

/** The longest delay a timer honours; browsers wrap a longer one, and Node clamps it, so it fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

// MARK: - Types

/** The status copy a form's markup sets on its status element, each absent when the markup leaves it out. */
export interface FormMessages {
  sending?: string
  uploading?: string
  success?: string
  genericError?: string
  networkError?: string
}

/** The parts of a bound form a submission step reads and writes. */
export interface SubmissionContext {
  readonly formElement: HTMLFormElement
  readonly statusElement: HTMLElement
  readonly messages: FormMessages
}

/** What a POST to the form's endpoints came to: its parsed `{ ok: true }` body, or the error to present. */
export type PostOutcome =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: string; fieldErrors?: Record<string, string> }

// MARK: - Response Parsing

/** Parse a response body as JSON, treating any malformed payload as "no result". */
function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Narrow an unknown value to a plain non-null object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
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

// MARK: - Request Settings

/**
 * The copy for a request that never completed: the network-error copy, else the generic error copy, so a form
 * whose markup sets only the latter still says something rather than leaving the status empty.
 */
export function networkErrorCopy(messages: FormMessages): string {
  return messages.networkError ?? messages.genericError ?? ''
}

/** Resolve the per-form request timeout, keeping the default for an override no timer can honour. */
export function resolveSubmitTimeout(formElement: HTMLFormElement): number {
  // A negative, non-finite or over-long override would fire at once and abort every request, so anything
  // outside what a timer can hold falls back to the default rather than breaking submission.
  const configured = Number(formElement.dataset.astroFormSubmitTimeout)
  return Number.isFinite(configured) && configured > 0 && configured <= MAX_TIMER_DELAY_MS
    ? configured
    : DEFAULT_SUBMIT_TIMEOUT_MS
}

/**
 * The URL a native submission would go to: the submitter's `formaction` when it has one, else the form's
 * `action` attribute, else the document. Read from the attribute because a control named `action`
 * shadows `formElement.action`.
 */
export function resolveSubmissionURL(
  formElement: HTMLFormElement,
  submitterElement: HTMLButtonElement | HTMLInputElement | null
) {
  if (submitterElement?.hasAttribute('formaction')) return submitterElement.formAction

  const action = formElement.getAttribute('action')
  return action ? new URL(action, document.baseURI).href : document.URL
}

// MARK: - Posting

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

/**
 * POST form data and interpret the reply against the `{ ok: true }` contract: success, the server's error
 * and field errors, or the network-error copy when no reply arrived.
 */
export async function postForm(context: SubmissionContext, url: string, formData: FormData): Promise<PostOutcome> {
  const { formElement, messages } = context
  const request = await sendRequest(url, formData, resolveSubmitTimeout(formElement))
  if (!request) return { ok: false, error: networkErrorCopy(messages) }

  // Success is the documented `{ ok: true }` contract — any other parseable 2xx body
  // (a proxy page, misrouting, a future endpoint) must not trigger the success UI.
  const { response, result } = request
  if (!(response.ok && isRecord(result) && result.ok === true)) {
    const serverError = isRecord(result) && typeof result.error === 'string' ? result.error : ''
    return { ok: false, error: serverError || messages.genericError || '', fieldErrors: readFieldErrors(result) }
  }

  return { ok: true, result }
}

import { resolveCopy, type FormErrors } from '#errors.js'

/** The default copy for the lines a plain response adds, for a form posted without JavaScript. */
export const PLAIN_COPY = {
  plainSubmitted: 'Form submitted. Please return to the home page.',
  plainRetry: 'Please go back and try again. If JavaScript is turned off in your browser, turning it on may help.'
} as const

/** `no-store` for the same reason as the JSON responses: each one belongs to a single submission. */
const PLAIN_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/plain; charset=utf-8'
} as const

/**
 * Whether a request is a form the browser posted itself, without JavaScript. A browser's own form post asks
 * for `text/html`; the toolkit's script asks for `application/json`, and `fetch()` accepts any type unless told
 * otherwise, so both of those keep getting JSON.
 *
 * @param request - The incoming request.
 * @returns `true` when the response should be one a person reads.
 */
export function wantsPlainResponse(request: Request): boolean {
  const accept = (request.headers.get('accept') ?? '').toLowerCase()
  return accept.includes('text/html') && !accept.includes('application/json')
}

/** What {@link plainResponse} needs besides the route's JSON response. */
export interface PlainResponseOptions {
  /** Where to send the browser once the submission succeeds; without it, a plain-text confirmation. */
  successURL?: string

  /** The site's copy overrides, which can replace either plain line. */
  errors?: FormErrors

  /** The submitted form data, for a copy resolver that localises by reading it. */
  data?: FormData
}

/**
 * Turns the route's JSON response into one a person sees after posting the form without JavaScript: a 303 to
 * `successURL` on success, or a plain-text confirmation without one; and on failure, plain text with the same
 * message, each field's message on its own line, and a line asking them to go back and try again, keeping
 * the failure's status.
 *
 * @param response - The route's JSON response.
 * @param options - Where success goes, the copy overrides, and the form data.
 * @returns The response for the browser.
 */
export async function plainResponse(response: Response, options: PlainResponseOptions): Promise<Response> {
  const copy = (key: keyof typeof PLAIN_COPY) =>
    resolveCopy(key, PLAIN_COPY[key], options.errors, { data: options.data })

  if (response.ok) {
    if (options.successURL) {
      return new Response(null, { status: 303, headers: { 'Cache-Control': 'no-store', Location: options.successURL } })
    }

    return new Response(copy('plainSubmitted'), { status: 200, headers: PLAIN_HEADERS })
  }

  const body = (await response.json().catch(() => ({}))) as { error?: unknown; fieldErrors?: unknown }
  const fieldMessages =
    typeof body.fieldErrors === 'object' && body.fieldErrors !== null
      ? Object.values(body.fieldErrors).filter((message): message is string => typeof message === 'string')
      : []
  const lines = [typeof body.error === 'string' ? body.error : '', ...fieldMessages].filter((line) => line !== '')

  return new Response([...lines, '', copy('plainRetry')].join('\n').trim(), {
    status: response.status,
    headers: PLAIN_HEADERS
  })
}

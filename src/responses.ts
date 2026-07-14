import { resolveCopy, type CopyContext, type FormError, type FormErrors, type ValidationFailure } from '#errors.js'

// `no-store` so a proxy/CDN never caches a per-submission success or error response.
const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json'
} as const

/**
 * Build a JSON error response.
 *
 * @param status - The HTTP status code.
 * @param message - The user-facing error string.
 * @returns A JSON `{ error }` response with the given status.
 */
export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS })
}

/**
 * Build the JSON error response for a {@link FormError}, preferring the site's copy override
 * for its key over the error's own default copy.
 *
 * @param error - The error to respond with.
 * @param overrides - The site's per-key copy overrides, if any.
 * @param context - What a resolver override may read about the request (the form data, if available).
 * @returns A JSON `{ error }` response carrying the resolved copy and the error's status.
 */
export function jsonFormError(error: FormError, overrides?: FormErrors, context: CopyContext = {}): Response {
  return jsonError(error.status, resolveCopy(error.key, error.message, overrides, context))
}

/**
 * Build the JSON response for a schema validation failure: `{ error, fieldErrors }`, with
 * `fieldErrors` omitted when empty so a keyed-error and a no-field-path failure look identical to a
 * client that only reads `error`.
 *
 * @param failure - The resolved summary and per-field messages.
 * @param status - The HTTP status to fail with (schema validation is `400`).
 * @returns A JSON `{ error, fieldErrors? }` response.
 */
export function jsonValidationError(failure: ValidationFailure, status = 400): Response {
  const body =
    Object.keys(failure.fieldErrors).length > 0
      ? { error: failure.summary, fieldErrors: failure.fieldErrors }
      : { error: failure.summary }
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/**
 * Build the standard success response.
 *
 * @returns A 200 JSON `{ ok: true }` response.
 */
export function jsonOk(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS })
}

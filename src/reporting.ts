/**
 * Which swallowed failure an `onError` call describes; `build` is a failed {@link defineLazyRoute}
 * build, reported through {@link LazyRouteOptions.onError}.
 */
export type FormErrorStage = 'build' | 'guard' | 'inspection' | 'enrichment' | 'delivery' | 'unexpected'

/** A route's error hook: called with each swallowed failure and the stage it happened in. */
export type ErrorReporter = (error: unknown, context: { stage: FormErrorStage }) => void | Promise<void>

// A bounded machine-identifier shape for `error.code`: short, and free of the spaces/`@`/`=` that
// free-text or interpolated submission data would carry. Provider `code`s aren't guaranteed PII-free
// (one set `code = 'recipient=ada@example.com'`), so anything outside this is dropped.
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

/** Whether a value can be logged as a machine identifier: a number, or a string of {@link SAFE_ERROR_CODE} shape. */
function isSafeIdentifier(value: unknown): value is number | string {
  return typeof value === 'number' || (typeof value === 'string' && SAFE_ERROR_CODE.test(value))
}

/**
 * A PII-safe one-line description of a thrown value for the default reporter: its class, a numeric
 * `status`, a `code` and `destination` only when they match a bounded machine-identifier, and the class
 * of its `cause` — never a message or body, and never free text, since those can quote submission data.
 */
function summarizeError(error: unknown): string {
  if (!(error instanceof Error)) return `non-error ${typeof error}`

  const parts = [error.name]
  const { code, status, destination } = error as { code?: unknown; status?: unknown; destination?: unknown }
  if (isSafeIdentifier(destination)) parts.push(`destination=${destination}`)
  if (isSafeIdentifier(code)) parts.push(`code=${code}`)
  if (typeof status === 'number') parts.push(`status=${status}`)
  if (error.cause instanceof Error) parts.push(`cause=${error.cause.name}`)
  return parts.join(' ')
}

/** The reporter a route uses when the site configures none: a PII-safe summary on `console.error`. */
export const defaultErrorReporter: ErrorReporter = (error, { stage }) =>
  console.error(`[astro-form-submissions] ${stage} error: ${summarizeError(error)}`)

/**
 * Wraps a reporter so every call is awaited (an async hook can't detach into an unhandled rejection)
 * and contained (a broken reporter can never replace the documented response). Reporter failures are
 * deliberately not re-reported: there is nowhere left to send them.
 *
 * @param onError - The site's reporter, or `undefined` for {@link defaultErrorReporter}.
 * @returns The contained reporter.
 */
export function containedReporter(onError: ErrorReporter | undefined) {
  const reporter = onError ?? defaultErrorReporter

  return async (error: unknown, stage: FormErrorStage): Promise<void> => {
    try {
      await reporter(error, { stage })
    } catch {
      /* see above */
    }
  }
}

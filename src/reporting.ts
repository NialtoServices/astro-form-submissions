import { SubmissionVerdictError, VERDICT_PAST_TENSE } from '#submission-verdict-error.js'

/**
 * Which swallowed failure an `onError` call describes; `build` is a failed {@link defineLazyRoute}
 * build, reported through {@link LazyRouteOptions.onError}. `validation` is a body that won't parse or a
 * schema refusal, and `upload` a failed write on {@link createUploadPutRoute} or a refusal on
 * {@link createUploadRoute}.
 */
export type FormErrorStage =
  'build' | 'guard' | 'validation' | 'inspection' | 'enrichment' | 'delivery' | 'upload' | 'unexpected'

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

/** A detail value as the default line prints it, or `undefined` when any part of it could be free text. */
function formatDetail(value: unknown): string | undefined {
  if (typeof value === 'boolean' || isSafeIdentifier(value)) return String(value)
  if (!Array.isArray(value)) return undefined

  const items = value.filter((item) => typeof item === 'boolean' || isSafeIdentifier(item))
  return items.length === value.length ? `[${items.join(',')}]` : undefined
}

/**
 * A PII-safe one-line description of a reported verdict: its code (`unspecified` when absent or free text)
 * and each detail whose key and value are bounded identifiers, numbers or booleans. An array prints only
 * when every item does, so a partly-filtered list never reads as the whole.
 */
function summarizeVerdict(verdict: SubmissionVerdictError): string {
  const parts = [isSafeIdentifier(verdict.code) ? String(verdict.code) : 'unspecified']
  for (const [key, value] of Object.entries(verdict.details ?? {})) {
    if (!SAFE_ERROR_CODE.test(key)) continue

    const formatted = formatDetail(value)
    if (formatted !== undefined) parts.push(`${key}=${formatted}`)
  }

  return parts.join(' ')
}

/**
 * The {@link ErrorReporter} a route uses when the site configures none. A reported verdict is expected
 * behaviour, so it goes to `console.warn` as its stage, action, code and safe details; anything else is a
 * failure, and goes to `console.error` as a PII-safe summary.
 *
 * @param error - The swallowed failure or reported verdict.
 * @param context - The stage it happened in.
 */
export function defaultErrorReporter(error: unknown, { stage }: { stage: FormErrorStage }): void {
  if (error instanceof SubmissionVerdictError) {
    console.warn(`[astro-form-submissions] ${stage} ${VERDICT_PAST_TENSE[error.action]}: ${summarizeVerdict(error)}`)
    return
  }

  console.error(`[astro-form-submissions] ${stage} error: ${summarizeError(error)}`)
}

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

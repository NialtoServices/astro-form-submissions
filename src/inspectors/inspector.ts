import { type FormSubmission, type Verdict } from '#pipeline.js'

/**
 * Everything an inspector may inspect about a submission-in-progress.
 */
export interface InspectionContext<E extends FormSubmission = FormSubmission> {
  /** The validated submission — the schema's output (a record). */
  submission: E

  /** The raw form data, for inspectors that read fields the site didn't map (e.g. a CAPTCHA/anti-bot token). */
  data: FormData

  /** The current request's URL. Its host can be proxy/client-influenced, so prefer `siteURL` for trust decisions. */
  requestURL: URL

  /** The configured site URL (Astro `site`), or `undefined` when unset — the trusted origin (never request-derived). */
  siteURL?: URL

  /**
   * The instant the submission arrived (stamped once when the request reaches the route), shared by
   * every stage so all rendered output agrees on one time. Do not mutate.
   */
  readonly submittedAt: Date

  /** The client IP when the runtime can resolve it; `undefined` in prerendered/static contexts. */
  clientAddress?: string

  /**
   * Report an operational error to the route's `onError` (stage `inspection`) without changing this
   * inspector's verdict — the diagnostics channel for fail-closed inspectors. Contained; never throws.
   */
  report?: (error: unknown) => void
}

/**
 * A pluggable screen run against each submission before delivery (bot verification, spam screening),
 * in configured order. **Fail-open** by default (a bug is reported and skipped); one that fails closed
 * on its own failures returns `{ action: 'reject' }`, and {@link Inspector.failClosed} closes it on a
 * bug too. A spam screener returns `{ action: 'quarantine' }` to withhold delivery from every
 * customer-facing dispatcher while still reaching those that opt in via `acceptsQuarantined`.
 */
export interface Inspector<E extends FormSubmission = FormSubmission> {
  /**
   * When `true`, an unexpected throw fails the request (`500`) instead of skipping the inspector.
   * Default `false` (fail open) — set it only on a custom security inspector a skip would defeat.
   */
  failClosed?: boolean

  /** Screen the submission and return a {@link Verdict}: accept, quarantine, drop, or reject. */
  inspect(context: InspectionContext<E>): Promise<Verdict>
}

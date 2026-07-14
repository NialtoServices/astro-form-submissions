import { type Verdict } from '#pipeline.js'

/**
 * Everything a guard may inspect before the request body is read. Guards run first, so they see only
 * the request envelope (no parsed submission or form data yet).
 */
export interface GuardContext {
  /** The raw request, for reading headers (e.g. `content-length`) before the body is parsed. */
  request: Request

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
   * Report an operational error to the route's `onError` hook (stage `guard`) without changing
   * this guard's verdict. Contained by the route — calling it can never throw.
   */
  report?: (error: unknown) => void
}

/**
 * A pluggable gate run before the request body is parsed (body-size cap, per-IP rate limit) — a cheap
 * refusal that avoids parsing a body that will be rejected anyway. **Fail-open** by default (a guard bug
 * is reported and skipped); {@link Guard.failClosed} closes it, and a deliberate refusal returns `{ action: 'reject' }`.
 */
export interface Guard {
  /**
   * When `true`, an unexpected throw fails the request (`500`) instead of being skipped. Default
   * `false` (fail open) — set it only where a skipped check is a security hole (an origin/geo gate).
   */
  failClosed?: boolean

  /** Gate the request before the body is read and return a {@link Verdict}: accept, quarantine, drop, or reject. */
  guard(context: GuardContext): Promise<Verdict>
}

import { formError } from '#errors.js'
import { type Guard, type GuardContext } from '#guards/guard.js'
import { type Verdict } from '#pipeline.js'

/**
 * The rate limiter {@link RateLimitGuard} throttles through: anything implementing
 * `limit({ key }) → { success }`. Declared structurally, so no backing store is assumed and the
 * toolkit needs no `@cloudflare/workers-types` dependency — e.g. a Cloudflare rate-limit binding
 * (`env.<LIMITER>`) satisfies it directly, and so does the bundled {@link InMemoryRateLimiter} or any
 * store-backed limiter you write (Redis, Upstash, a durable counter).
 */
export interface RateLimiter {
  /** Records a hit for `key` and reports whether it is still within the configured rate. */
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/**
 * @deprecated Renamed to {@link RateLimiter}; this alias will be removed in a future release.
 */
export type RateLimiterLike = RateLimiter

/** Options for constructing a {@link RateLimitGuard}. */
export interface RateLimitGuardOptions {
  /** The rate limiter to throttle through (e.g. {@link InMemoryRateLimiter}, or a Cloudflare `env.CONTACT_LIMITER` binding). */
  limiter: RateLimiter

  /**
   * The throttle key for a request. Default: the client address; with no custom key and no resolvable
   * address, the guard fails open rather than share one bucket across address-less callers.
   */
  key?: (context: GuardContext) => string
}

/**
 * Per-request throttle, run before the body is parsed so an abusive caller can't make the route parse a
 * (potentially large) body on every attempt.
 *
 * **Fails open** so a limiter outage never blocks a submission (and some limiters are a no-op in
 * certain environments — e.g. a Cloudflare binding under `wrangler dev`). It also fails open when the
 * default key has no resolvable address, rather
 * than share one bucket across address-less callers — pass `key` to throttle those another way.
 */
export class RateLimitGuard implements Guard {
  /** Errors this guard rejects with. Override the copy per-site via `errors[key]`. */
  static readonly errors = {
    rateLimited: formError('rateLimited', 429, 'Too many attempts. Please wait a moment and try again.')
  }

  // MARK: - Object Lifecycle

  /**
   * Creates a rate-limit guard.
   *
   * @param options - The limiter and optional key function.
   */
  constructor(private readonly options: RateLimitGuardOptions) {}

  // MARK: - Guard API

  async guard(context: GuardContext): Promise<Verdict> {
    const key = this.options.key ? this.options.key(context) : context.clientAddress

    // No per-client key (no custom `key`, no resolvable address) → fail open rather than throttle every
    // such caller against one shared bucket, which would let a single one exhaust everyone's quota.
    if (key === undefined) {
      context.report?.(new Error('Rate limiter has no client key for this request; failing open'))
      return { action: 'accept' }
    }

    // Fail open on a limiter error (an outage must never reject a legitimate submission), but report
    // it — without the possibly-sensitive key — so a silently-disabled throttle doesn't go unnoticed.
    const { success } = await this.options.limiter.limit({ key }).catch((error: unknown) => {
      context.report?.(new Error('Rate limiter unavailable; failing open', { cause: error }))
      return { success: true }
    })

    return success ? { action: 'accept' } : { action: 'reject', error: RateLimitGuard.errors.rateLimited }
  }
}

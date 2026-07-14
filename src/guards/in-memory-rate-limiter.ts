import { type RateLimiter } from '#guards/rate-limit.js'

/** The default {@link InMemoryRateLimiterOptions.maxKeys} cap when none is supplied. */
const DEFAULT_MAX_KEYS = 100_000

/** Options for constructing an {@link InMemoryRateLimiter}. */
export interface InMemoryRateLimiterOptions {
  /** Maximum hits allowed per key within each window. Must be a finite positive number. */
  limit: number

  /** Window length in seconds; the count resets once a window elapses. Must be a finite positive number. */
  windowSeconds: number

  /**
   * Hard ceiling on distinct keys tracked at once. Defaults to {@link DEFAULT_MAX_KEYS}. Bounds memory
   * against a caller minting unique keys (e.g. spoofed addresses across a large IPv6 space) faster than
   * their windows elapse: at the ceiling the oldest key is evicted, so a legitimate caller's window may
   * be dropped and reset rather than the process exhausting memory. Must be a finite positive number.
   */
  maxKeys?: number
}

/** The live counter tracked for one key: hits so far and when the current window expires. */
interface Window {
  count: number
  resetAt: number
}

/**
 * A batteries-included {@link RateLimiter}: a fixed-window counter held in a per-key `Map`.
 *
 * **Per-isolate and non-durable.** State lives only in this process's memory and is lost on restart,
 * so it is correct only for local dev or a single long-lived instance. It does **not** coordinate
 * across serverless instances or workers — each keeps its own counts, so the effective limit
 * multiplies by the instance count; multi-instance deployments need a shared store (Redis, Upstash, a
 * Cloudflare rate-limit binding, or a Durable Object). It is useful under `wrangler dev`, where a
 * Cloudflare rate-limit binding is a no-op, giving real throttling there.
 *
 * **Bounded.** Elapsed windows are swept as keys are seen and the map is capped at
 * {@link InMemoryRateLimiterOptions.maxKeys}, so tracked keys can't grow without limit even under an
 * attacker who varies the key faster than windows expire.
 */
export class InMemoryRateLimiter implements RateLimiter {
  // MARK: - Object Lifecycle

  private readonly windows = new Map<string, Window>()
  private readonly maxKeys: number
  private lastSweepAt = 0

  /**
   * Creates an in-memory rate limiter.
   *
   * @param options - The per-window hit limit, window length, and optional key ceiling.
   * @throws When `limit`, `windowSeconds`, or `maxKeys` is not a finite positive number.
   */
  constructor(private readonly options: InMemoryRateLimiterOptions) {
    if (!Number.isFinite(options.limit) || options.limit <= 0) {
      throw new Error('InMemoryRateLimiter `limit` must be a finite positive number.')
    }

    if (!Number.isFinite(options.windowSeconds) || options.windowSeconds <= 0) {
      throw new Error('InMemoryRateLimiter `windowSeconds` must be a finite positive number.')
    }

    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS

    if (!Number.isFinite(this.maxKeys) || this.maxKeys <= 0) {
      throw new Error('InMemoryRateLimiter `maxKeys` must be a finite positive number.')
    }
  }

  // MARK: - RateLimiter

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = Date.now()
    const existing = this.windows.get(key)

    // Start a fresh window on the first hit for a key or once the previous one has elapsed.
    if (!existing || now >= existing.resetAt) {
      this.reclaim(now)
      this.windows.set(key, { count: 1, resetAt: now + this.options.windowSeconds * 1000 })
      return { success: true }
    }

    existing.count++

    return { success: existing.count <= this.options.limit }
  }

  // MARK: - Eviction

  /**
   * Keeps {@link windows} bounded before a new key is inserted. Sweeps elapsed windows at most once per
   * window length — so its O(n) cost amortises to O(1) per call under steady traffic — then, if the map
   * is still at the ceiling, drops oldest-inserted keys until there is room. `Map` iterates in insertion
   * order, so the first key is the oldest.
   */
  private reclaim(now: number): void {
    if (now - this.lastSweepAt >= this.options.windowSeconds * 1000) {
      for (const [existingKey, window] of this.windows) {
        if (now >= window.resetAt) this.windows.delete(existingKey)
      }

      this.lastSweepAt = now
    }

    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value
      if (oldest === undefined) break

      this.windows.delete(oldest)
    }
  }
}

import { InMemoryRateLimiter } from '#guards/in-memory-rate-limiter.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('InMemoryRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a non-positive or non-finite limit at construction', () => {
    expect(() => new InMemoryRateLimiter({ limit: 0, windowSeconds: 60 })).toThrow(/limit/)
    expect(() => new InMemoryRateLimiter({ limit: Infinity, windowSeconds: 60 })).toThrow(/limit/)
  })

  it('rejects a non-positive or non-finite window at construction', () => {
    expect(() => new InMemoryRateLimiter({ limit: 3, windowSeconds: 0 })).toThrow(/windowSeconds/)
    expect(() => new InMemoryRateLimiter({ limit: 3, windowSeconds: Number.NaN })).toThrow(/windowSeconds/)
  })

  it('rejects a non-positive or non-finite maxKeys at construction', () => {
    expect(() => new InMemoryRateLimiter({ limit: 3, windowSeconds: 60, maxKeys: 0 })).toThrow(/maxKeys/)
    expect(() => new InMemoryRateLimiter({ limit: 3, windowSeconds: 60, maxKeys: Infinity })).toThrow(/maxKeys/)
  })

  it('caps tracked keys at maxKeys, evicting the oldest to bound memory', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowSeconds: 60, maxKeys: 1 })

    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: false })

    // A second key evicts 'a' (the map holds only `maxKeys` entries)…
    expect(await limiter.limit({ key: 'b' })).toEqual({ success: true })

    // …so 'a' is now untracked and starts a fresh window rather than staying rejected.
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
  })

  it('does not evict a tracked key while under the maxKeys ceiling', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowSeconds: 60, maxKeys: 2 })

    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'b' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: false })
  })

  it('allows hits up to the limit, then rejects once over', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 3, windowSeconds: 60 })

    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: false })
  })

  it('counts each key independently', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowSeconds: 60 })

    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'b' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: false })
  })

  it('resets the count once the window elapses', async () => {
    vi.useFakeTimers()
    const limiter = new InMemoryRateLimiter({ limit: 1, windowSeconds: 60 })

    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: false })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
  })
})

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

  it('rejects a missing limit or window from an untyped caller at construction', () => {
    expect(() => new InMemoryRateLimiter({ windowSeconds: 60 } as never)).toThrow(/limit/)
    expect(() => new InMemoryRateLimiter({ limit: 3 } as never)).toThrow(/windowSeconds/)
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

  it('sweeps elapsed windows before inserting, so a live window is never evicted in their place', async () => {
    vi.useFakeTimers()
    const limiter = new InMemoryRateLimiter({ limit: 1, windowSeconds: 60, maxKeys: 3 })
    await limiter.limit({ key: 'a' })
    await limiter.limit({ key: 'b' })

    // 'a' starts a fresh window but keeps its place as the oldest key; 'b' lapses beside it.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })

    // Without the sweep, the lapsed 'b' would still fill a slot, and 'd' would evict the live 'a'.
    await vi.advanceTimersByTimeAsync(1_000)
    await limiter.limit({ key: 'c' })
    await limiter.limit({ key: 'd' })

    expect(await limiter.limit({ key: 'a' })).toEqual({ success: false })
  })

  it('counts an oversized key, storing it at a fixed size', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowSeconds: 60 })
    const spoofed = (filler: string) => `form:${filler.repeat(15_000)}`

    expect(await limiter.limit({ key: spoofed('a') })).toEqual({ success: true })
    expect(await limiter.limit({ key: spoofed('a') })).toEqual({ success: false })
    expect(await limiter.limit({ key: spoofed('b') })).toEqual({ success: true })

    // The sender controls the key's length, so what is held per key must not grow with it.
    const storedKeys = [...(limiter as unknown as { windows: Map<string, unknown> }).windows.keys()]
    expect(storedKeys).toHaveLength(2)
    expect(Math.max(...storedKeys.map((storedKey) => storedKey.length))).toBeLessThanOrEqual(128)
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

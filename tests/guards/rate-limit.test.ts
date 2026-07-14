import { type GuardContext } from '#guards/guard.js'
import { RateLimitGuard, type RateLimiter } from '#guards/rate-limit.js'
import { describe, expect, it, vi } from 'vitest'

function guardContext(clientAddress?: string): GuardContext {
  return {
    request: new Request('https://example.com/api/form', { method: 'POST' }),
    requestURL: new URL('https://example.com/api/form'),
    siteURL: new URL('https://example.com/'),
    submittedAt: new Date('2026-01-02T03:04:05Z'),
    clientAddress: clientAddress ?? '1.2.3.4'
  }
}

function stubLimiter(outcome: { success: boolean } | Error) {
  const limit = vi.fn(() => (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)))
  return { limiter: { limit } as RateLimiter, limit }
}

describe('RateLimitGuard', () => {
  it('passes when the limiter reports within-rate', async () => {
    const { limiter } = stubLimiter({ success: true })
    expect(await new RateLimitGuard({ limiter }).guard(guardContext())).toEqual({ action: 'accept' })
  })

  it('rejects when the limiter reports over-rate', async () => {
    const { limiter } = stubLimiter({ success: false })
    expect(await new RateLimitGuard({ limiter }).guard(guardContext())).toEqual({
      action: 'reject',
      error: RateLimitGuard.errors.rateLimited
    })
  })

  it('fails open when the limiter binding throws, and reports it without the key', async () => {
    const { limiter } = stubLimiter(new Error('binding unavailable'))
    const report = vi.fn()
    const context = { ...guardContext('10.0.0.1'), report }
    expect(await new RateLimitGuard({ limiter }).guard(context)).toEqual({ action: 'accept' })

    expect(report).toHaveBeenCalledOnce()
    expect(String(report.mock.calls[0]![0])).not.toContain('10.0.0.1')
  })

  it('keys by client address by default', async () => {
    const { limiter, limit } = stubLimiter({ success: true })
    await new RateLimitGuard({ limiter }).guard(guardContext('9.9.9.9'))
    expect(limit).toHaveBeenCalledWith({ key: '9.9.9.9' })
  })

  it('fails open without touching the limiter when there is no address and no custom key', async () => {
    const { limiter, limit } = stubLimiter({ success: true })
    const report = vi.fn()
    const context = { ...guardContext(), report }
    delete context.clientAddress

    // Address-less callers must not share one bucket, so the guard passes them and never keys the limiter.
    expect(await new RateLimitGuard({ limiter }).guard(context)).toEqual({ action: 'accept' })
    expect(limit).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
  })

  it('still throttles an address-less request when a custom key supplies its own dimension', async () => {
    const { limiter, limit } = stubLimiter({ success: true })
    const context = guardContext()
    delete context.clientAddress
    await new RateLimitGuard({ limiter, key: () => 'per-form-key' }).guard(context)
    expect(limit).toHaveBeenCalledWith({ key: 'per-form-key' })
  })

  it('honours a custom key function', async () => {
    const { limiter, limit } = stubLimiter({ success: true })
    await new RateLimitGuard({ limiter, key: () => 'per-form-key' }).guard(guardContext())
    expect(limit).toHaveBeenCalledWith({ key: 'per-form-key' })
  })
})

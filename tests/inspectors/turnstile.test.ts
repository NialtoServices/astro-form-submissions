import type { InspectionContext } from '#inspectors/inspector.js'
import { TurnstileInspector } from '#inspectors/turnstile.js'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { stubFetch } from '../support/harness.js'

function contextFor(
  token: string | undefined,
  options: { host?: string; siteURL?: URL | null } = {}
): InspectionContext & { report: Mock<(error: unknown) => void> } {
  const host = options.host ?? 'example.com'

  // An explicit `siteURL: null` must model "Astro site unset", not the default.
  const siteURL = 'siteURL' in options ? (options.siteURL ?? undefined) : new URL('https://example.com/')
  const data = new FormData()
  if (token !== undefined) data.set('cf-turnstile-response', token)
  return {
    submission: {},
    data,
    requestURL: new URL(`https://${host}/api/form`),
    siteURL,
    submittedAt: new Date('2026-01-02T03:04:05Z'),
    clientAddress: '1.2.3.4',
    report: vi.fn<(error: unknown) => void>()
  }
}

function mockSiteverify(body: BodyInit | null, status = 200) {
  stubFetch(() => new Response(body, { status }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TurnstileInspector', () => {
  it('passes when verification succeeds', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'example.com' }))
    const result = await new TurnstileInspector({ secretKey: 'secret' }).inspect(contextFor('token'))
    expect(result).toEqual({ action: 'accept' })
  })

  it('does not check the hostname by default — a token solved elsewhere still passes', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'other.com' }))
    const result = await new TurnstileInspector({ secretKey: 'secret' }).inspect(contextFor('token'))
    expect(result).toEqual({ action: 'accept' })
  })

  it('rejects an empty token without a network call or an operational report', async () => {
    const fetchSpy = stubFetch(() => new Response())
    const context = contextFor(undefined)
    const result = await new TurnstileInspector({ secretKey: 'secret' }).inspect(context)
    expect(result).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(context.report).not.toHaveBeenCalled()
  })

  it('rejects when verification is unsuccessful', async () => {
    mockSiteverify(JSON.stringify({ success: false }))
    const result = await new TurnstileInspector({ secretKey: 'secret' }).inspect(contextFor('token'))
    expect(result).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })
  })

  it('rejects on a non-2xx response', async () => {
    mockSiteverify('', 500)
    const result = await new TurnstileInspector({ secretKey: 'secret' }).inspect(contextFor('token'))
    expect(result).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })
  })

  it('rejects (never throws) on a network error', async () => {
    stubFetch(() => Promise.reject(new Error('boom')))
    const result = await new TurnstileInspector({ secretKey: 'secret' }).inspect(contextFor('token'))
    expect(result).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })
  })

  it('rejects on an unparseable body', async () => {
    mockSiteverify('not json')
    const result = await new TurnstileInspector({ secretKey: 'secret' }).inspect(contextFor('token'))
    expect(result).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })
  })

  it('rejects a schema-invalid body whose success flag is not a boolean', async () => {
    mockSiteverify(JSON.stringify({ success: 'false', hostname: 'example.com' }))
    const result = await new TurnstileInspector({ secretKey: 'secret' }).inspect(contextFor('token'))
    expect(result).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })
  })

  it('rejects when the verification service hangs past the timeout', async () => {
    vi.useFakeTimers()
    try {
      // A fetch that never settles until its abort signal fires — the observable behaviour of a hung upstream.
      stubFetch(
        (_requestUrl, requestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestInit?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          })
      )

      const pending = new TurnstileInspector({ secretKey: 'secret' }).inspect(contextFor('token'))
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends the secret, token, and client IP to the siteverify endpoint', async () => {
    const fetchSpy = stubFetch(() => new Response(JSON.stringify({ success: true, hostname: 'example.com' })))
    await new TurnstileInspector({ secretKey: 'secret-key-1' }).inspect(contextFor('token-1'))

    const [requestUrl, requestInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(requestUrl).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(requestInit.method).toBe('POST')
    const body = requestInit.body as FormData
    expect(body.get('secret')).toBe('secret-key-1')
    expect(body.get('response')).toBe('token-1')
    expect(body.get('remoteip')).toBe('1.2.3.4')
  })

  it('omits remoteip when the client address is unknown', async () => {
    const fetchSpy = stubFetch(() => new Response(JSON.stringify({ success: true, hostname: 'example.com' })))
    const context = contextFor('token')
    delete context.clientAddress
    await new TurnstileInspector({ secretKey: 'secret' }).inspect(context)

    const [, requestInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect((requestInit.body as FormData).get('remoteip')).toBeNull()
  })

  it('withholds remoteip when sendRemoteIP is false, even with a known client address', async () => {
    const fetchSpy = stubFetch(() => new Response(JSON.stringify({ success: true, hostname: 'example.com' })))
    await new TurnstileInspector({ secretKey: 'secret', sendRemoteIP: false }).inspect(contextFor('token'))

    const [, requestInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect((requestInit.body as FormData).get('remoteip')).toBeNull()
  })

  it('reads the token from a custom field name', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'example.com' }))
    const context = contextFor(undefined)
    context.data.set('custom-token', 'token')
    const inspector = new TurnstileInspector({ secretKey: 'secret', tokenField: 'custom-token' })
    expect(await inspector.inspect(context)).toEqual({ action: 'accept' })
  })
})

describe('TurnstileInspector hostname binding (opt-in via verifyHostname)', () => {
  it('rejects on a hostname mismatch', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'other.com' }))
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: true })
    expect(await inspector.inspect(contextFor('token'))).toEqual({
      action: 'reject',
      error: TurnstileInspector.errors.verification
    })
  })

  it('binds against the configured site host, not the request host', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'example.com' }))
    const context = contextFor('token', { host: 'preview.example.dev', siteURL: new URL('https://example.com/') })
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: true })
    expect(await inspector.inspect(context)).toEqual({ action: 'accept' })
  })

  it('rejects a replayed token even when the request host matches it', async () => {
    // The replay scenario: a token solved on evil.com arrives with a spoofed Host header of
    // evil.com, so the request-derived host would match — the configured site host must not.
    mockSiteverify(JSON.stringify({ success: true, hostname: 'evil.com' }))
    const context = contextFor('token', { host: 'evil.com', siteURL: new URL('https://example.com/') })
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: true })
    expect(await inspector.inspect(context)).toEqual({
      action: 'reject',
      error: TurnstileInspector.errors.verification
    })
  })

  it('verifies against an explicit hostname string, overriding the configured site host', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'forms.example.com' }))
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: 'forms.example.com' })
    expect(await inspector.inspect(contextFor('token'))).toEqual({ action: 'accept' })
  })

  it('accepts a token solved on any host in the allowlist', async () => {
    const inspector = new TurnstileInspector({
      secretKey: 'secret',
      verifyHostname: ['example.com', 'my-site.nialto.workers.dev']
    })

    mockSiteverify(JSON.stringify({ success: true, hostname: 'my-site.nialto.workers.dev' }))
    expect(await inspector.inspect(contextFor('token'))).toEqual({ action: 'accept' })

    mockSiteverify(JSON.stringify({ success: true, hostname: 'example.com' }))
    expect(await inspector.inspect(contextFor('token'))).toEqual({ action: 'accept' })
  })

  it('rejects a token solved on a hostname outside the allowlist', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'attacker.example' }))
    const inspector = new TurnstileInspector({
      secretKey: 'secret',
      verifyHostname: ['example.com', 'my-site.nialto.workers.dev']
    })
    expect(await inspector.inspect(contextFor('token'))).toEqual({
      action: 'reject',
      error: TurnstileInspector.errors.verification
    })
  })

  it('rejects and reports when any allowlist entry is invalid', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'example.com' }))
    const context = contextFor('token')
    const inspector = new TurnstileInspector({
      secretKey: 'secret',
      verifyHostname: ['example.com', 'exa mple.com/path']
    })

    expect(await inspector.inspect(context)).toEqual({
      action: 'reject',
      error: TurnstileInspector.errors.verification
    })
    expect(context.report).toHaveBeenCalledOnce()
    expect(String(context.report.mock.calls[0]![0])).toContain('not a valid hostname')
  })

  it('rejects every submission and reports once for a literal empty allowlist', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'example.com' }))
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: [] })
    const first = contextFor('token')
    const second = contextFor('token')

    expect(await inspector.inspect(first)).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })
    expect(await inspector.inspect(second)).toEqual({ action: 'reject', error: TurnstileInspector.errors.verification })

    // The diagnostic fires once across requests, not on every deterministic rejection.
    expect(first.report).toHaveBeenCalledOnce()
    expect(String(first.report.mock.calls[0]![0])).toContain('empty allowlist')
    expect(second.report).not.toHaveBeenCalled()
  })

  it('compares hostnames case-insensitively in both directions', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'EXAMPLE.com' }))
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: 'Example.COM' })
    expect(await inspector.inspect(contextFor('token'))).toEqual({ action: 'accept' })
  })

  it('does not let a path or port smuggle past hostname validation', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'example.com' }))
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: 'example.com:8443/evil' })
    expect(await inspector.inspect(contextFor('token'))).toEqual({
      action: 'reject',
      error: TurnstileInspector.errors.verification
    })
  })

  it('rejects and reports rather than trusting the request host when no trusted hostname exists', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'example.com' }))
    const context = contextFor('token', { siteURL: null })
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: true })

    expect(await inspector.inspect(context)).toEqual({
      action: 'reject',
      error: TurnstileInspector.errors.verification
    })
    expect(context.report).toHaveBeenCalledOnce()
    expect(String(context.report.mock.calls[0]![0])).toContain('no trusted hostname')
  })

  it('fails closed when a successful verification omits the hostname', async () => {
    mockSiteverify(JSON.stringify({ success: true }))
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: true })
    expect(await inspector.inspect(contextFor('token'))).toEqual({
      action: 'reject',
      error: TurnstileInspector.errors.verification
    })
  })

  it('skips the hostname check entirely when disabled', async () => {
    mockSiteverify(JSON.stringify({ success: true, hostname: 'other.com' }))
    const inspector = new TurnstileInspector({ secretKey: 'secret', verifyHostname: false })
    expect(await inspector.inspect(contextFor('token'))).toEqual({ action: 'accept' })
  })
})

describe('TurnstileInspector operational diagnostics', () => {
  async function reportFor(setup: () => void, body?: string, status = 200) {
    if (body !== undefined) mockSiteverify(body, status)
    else setup()
    const context = contextFor('token')
    await new TurnstileInspector({ secretKey: 'secret' }).inspect(context)
    return context.report
  }

  it('reports a non-2xx siteverify response with its status', async () => {
    const report = await reportFor(() => {}, '', 503)
    expect(report).toHaveBeenCalledOnce()
    expect(String(report.mock.calls[0]![0])).toContain('status 503')
  })

  it('reports an unreachable or timed-out siteverify', async () => {
    const report = await reportFor(() => {
      stubFetch(() => Promise.reject(new Error('boom')))
    })
    expect(report).toHaveBeenCalledOnce()
    expect(String(report.mock.calls[0]![0])).toContain('unreachable or timed out')
  })

  it('reports a schema-invalid response body', async () => {
    const report = await reportFor(() => {}, JSON.stringify({ success: 'false' }))
    expect(report).toHaveBeenCalledOnce()
    expect(String(report.mock.calls[0]![0])).toContain('invalid response body')
  })

  it('reports operational error codes such as an invalid secret', async () => {
    const report = await reportFor(
      () => {},
      JSON.stringify({ success: false, 'error-codes': ['invalid-input-secret'] })
    )
    expect(report).toHaveBeenCalledOnce()
    expect(String(report.mock.calls[0]![0])).toContain('invalid-input-secret')
  })

  it('stays silent for expected token invalidity', async () => {
    const report = await reportFor(
      () => {},
      JSON.stringify({ success: false, 'error-codes': ['invalid-input-response', 'timeout-or-duplicate'] })
    )
    expect(report).not.toHaveBeenCalled()
  })

  it('never includes the token or secret values in a report', async () => {
    mockSiteverify('', 503)
    const context = contextFor('tok-sensitive-12345')
    await new TurnstileInspector({ secretKey: 'sec-sensitive-67890' }).inspect(context)

    const reported = String(context.report.mock.calls[0]![0])
    expect(reported).not.toContain('tok-sensitive-12345')
    expect(reported).not.toContain('sec-sensitive-67890')
  })
})

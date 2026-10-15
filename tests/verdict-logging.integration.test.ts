import type { StandardSchemaV1 } from '@standard-schema/spec'
import { RateLimitGuard } from '#guards/rate-limit.js'
import { HoneypotInspector } from '#inspectors/honeypot.js'
import { TurnstileInspector } from '#inspectors/turnstile.js'
import { createFormRoute } from '#route.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRouteContext, stubFetch } from './support/harness.js'

const SENTINELS = ['ada.sentinel@example.com', 'Sentinel Lovelace', 'sentinel message body', 'sentinel-token-value']

/** A site's validator; its issue message quotes what the sender typed, as many libraries' do. */
const schema: StandardSchemaV1<Record<string, unknown>, { name: string; email: string; message: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const record = value as Record<string, string | undefined>
      if (!record.email?.includes('@')) {
        return { issues: [{ message: `"${record.email}" is not a valid email address`, path: ['email'] }] }
      }

      return { value: { name: record.name ?? '', email: record.email, message: record.message ?? '' } }
    }
  }
}

function submission(overrides: Record<string, string> = {}) {
  const body = new FormData()
  body.set('name', SENTINELS[1]!)
  body.set('email', SENTINELS[0]!)
  body.set('message', SENTINELS[2]!)
  body.set('cf-turnstile-response', SENTINELS[3]!)
  for (const [key, value] of Object.entries(overrides)) body.set(key, value)
  return makeRouteContext({ body })
}

/** A route configured as a site would be, with no `onError`, so the default reporter writes the log. */
function route() {
  return createFormRoute({
    schema,
    inspectors: [
      new HoneypotInspector({ fieldName: 'website' }),
      new TurnstileInspector({ secretKey: 'secret', verifyHostname: 'example.com' })
    ]
  })
}

/** Everything the default reporter writes, read back as one string. */
function captureConsole() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  return () => [...warn.mock.calls, ...error.mock.calls].flat().map(String).join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the default log for a turned-away submission', () => {
  it('names a hostname mismatch between the configured and solved host', async () => {
    stubFetch(() => new Response(JSON.stringify({ success: true, hostname: 'localhost' })))
    const logged = captureConsole()

    const response = await route()(submission())

    expect(response.status).toBe(400)
    expect(logged()).toBe(
      '[astro-form-submissions] inspection rejected: turnstile.hostname-mismatch expected=[example.com] solved=localhost'
    )
  })

  it('names a filled honeypot, though the sender sees success', async () => {
    const logged = captureConsole()

    const response = await route()(submission({ website: 'http://spam.example' }))

    expect(response.status).toBe(200)
    expect(logged()).toBe('[astro-form-submissions] inspection dropped: honeypot.filled field=website')
  })

  it('names the failing field, never what was typed', async () => {
    const logged = captureConsole()

    await route()(submission({ email: 'sentinel-not-an-email' }))

    expect(logged()).toBe('[astro-form-submissions] validation rejected: schema.invalid fields=[email]')
  })

  it('names a rate-limited request', async () => {
    const logged = captureConsole()
    const limited = createFormRoute({
      schema,
      guards: [new RateLimitGuard({ limiter: { limit: async () => ({ success: false }) } })]
    })

    const response = await limited(submission())

    expect(response.status).toBe(429)
    expect(logged()).toBe('[astro-form-submissions] guard rejected: rate-limit.exceeded')
  })

  it('never logs a submitted value, whichever way the submission is turned away', async () => {
    const logged = captureConsole()

    stubFetch(() => new Response(JSON.stringify({ success: true, hostname: 'localhost' })))
    await route()(submission())
    stubFetch(() => new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] })))
    await route()(submission())
    stubFetch(() => new Response('', { status: 500 }))
    await route()(submission())
    await route()(submission({ website: 'filled' }))
    await route()(submission({ email: 'sentinel-not-an-email' }))

    const output = logged()
    expect(output).toContain('turnstile.token-rejected errorCodes=[timeout-or-duplicate]')
    expect(output).toContain('turnstile.siteverify-failed failure=status status=500')
    for (const sentinel of [...SENTINELS, 'sentinel-not-an-email']) expect(output).not.toContain(sentinel)
  })
})

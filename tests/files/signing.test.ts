import { type EnrichmentContext } from '#enrichers/enricher.js'
import { signedLink, signFileToken, verifyFileToken } from '#files/signing.js'
import { describe, expect, it } from 'vitest'

const SECRET = 'a-sufficiently-long-signing-secret'
const inOneHour = () => Math.floor(Date.now() / 1000) + 3600

// The opaque token claims (object key + expiry) — never the filename or content-type.
const token = { objectKey: 'abc-123', exp: inOneHour() }

// The stored-file descriptor a link builder receives.
const stored = { objectKey: 'abc-123', filename: 'quote.pdf', contentType: 'application/pdf' }

describe('signFileToken / verifyFileToken', () => {
  it('round-trips the claims through sign then verify', async () => {
    const signed = await signFileToken(token, SECRET)
    expect(await verifyFileToken(signed, SECRET)).toEqual(token)
  })

  it('rejects a token verified with a different secret', async () => {
    const signed = await signFileToken(token, SECRET)
    expect(await verifyFileToken(signed, 'a-different-secret')).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await signFileToken(token, SECRET)).split('.')
    const forgedBody = btoa(JSON.stringify({ ...token, objectKey: 'someone-elses-file' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(await verifyFileToken(`${header}.${forgedBody}.${signature}`, SECRET)).toBeNull()
  })

  it('rejects a malformed token without throwing', async () => {
    expect(await verifyFileToken('not-a-token', SECRET)).toBeNull()
    expect(await verifyFileToken('a.b.c', SECRET)).toBeNull()
    expect(await verifyFileToken('', SECRET)).toBeNull()
  })

  it('rejects an authentically-signed but expired token', async () => {
    const expired = await signFileToken({ objectKey: 'abc-123', exp: Math.floor(Date.now() / 1000) - 1 }, SECRET)
    expect(await verifyFileToken(expired, SECRET)).toBeNull()
  })

  it('carries no filename or content-type in the token body (opaque)', async () => {
    const signed = await signFileToken(token, SECRET)
    const body = signed.split('.')[1]!
    const decoded = atob(body.replace(/-/g, '+').replace(/_/g, '/'))
    expect(decoded).not.toContain('quote.pdf')
    expect(decoded).not.toContain('application/pdf')
  })
})

describe('signedLink', () => {
  const context = { siteURL: new URL('https://example.com/') } as EnrichmentContext
  const noSite = {} as EnrichmentContext

  it('builds an absolute download URL under the base path', async () => {
    const link = signedLink({ secret: SECRET })
    const url = await link(stored, context)
    expect(url.startsWith('https://example.com/files/')).toBe(true)
    expect(url.endsWith('/')).toBe(true)
  })

  it('fails closed when no trusted base is available (no site, no baseURL)', async () => {
    await expect(signedLink({ secret: SECRET })(stored, noSite)).rejects.toThrow(/trusted base URL/)
  })

  it('uses an explicit baseURL over the configured site host', async () => {
    const url = await signedLink({ secret: SECRET, baseURL: 'https://cdn.example.net' })(stored, noSite)
    expect(url.startsWith('https://cdn.example.net/files/')).toBe(true)
  })

  it('produces a token segment free of dots so trailing-slash routing keeps it', async () => {
    const url = await signedLink({ secret: SECRET })(stored, context)
    const tokenSegment = new URL(url).pathname.split('/').filter(Boolean)[1]
    expect(tokenSegment).not.toContain('.')
    expect(tokenSegment).toContain('~')
  })

  it('honours a custom base path', async () => {
    const url = await signedLink({ secret: SECRET, basePath: '/downloads' })(stored, context)
    expect(new URL(url).pathname.startsWith('/downloads/')).toBe(true)
  })

  it('signs an opaque token for the stored object, bounded by ttlSeconds', async () => {
    const before = Math.floor(Date.now() / 1000)
    const url = await signedLink({ secret: SECRET, ttlSeconds: 60 })(stored, context)
    const signed = new URL(url).pathname.split('/').filter(Boolean)[1]!.replaceAll('~', '.')

    const claims = (await verifyFileToken(signed, SECRET))!
    expect(claims.objectKey).toBe(stored.objectKey)
    expect(claims.exp).toBeGreaterThanOrEqual(before + 60)
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60)
  })

  it('throws at construction on a secret too short to be safe', () => {
    expect(() => signedLink({ secret: 'short' })).toThrow(/at least 32 characters/)
    expect(() => signedLink({ secret: '' })).toThrow(/at least 32 characters/)
  })

  it.each([0, -60, NaN, Infinity])('throws at construction on a non-positive/non-finite ttlSeconds (%s)', (ttl) => {
    expect(() => signedLink({ secret: SECRET, ttlSeconds: ttl })).toThrow(/finite positive/)
  })
})

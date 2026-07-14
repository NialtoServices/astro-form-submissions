import { createFileRoute } from '#files/file-route.js'
import { signFileToken } from '#files/signing.js'
import { type FileStorage, type StoredObject } from '#storage/storage.js'
import type { APIRoute } from 'astro'
import { describe, expect, it, vi } from 'vitest'

const SECRET = 'a-sufficiently-long-signing-secret'
const OBJECT_KEY = 'obj-1'
const inOneHour = () => Math.floor(Date.now() / 1000) + 3600

const STORED: StoredObject = {
  body: new ReadableStream(),
  contentType: 'application/pdf',
  filename: 'quote.pdf'
}

/** Storage holding one object (with its download metadata); records which keys were requested. */
function stubStorage(object: StoredObject | null) {
  const storage: FileStorage = {
    put: vi.fn(async () => {}),
    get: vi.fn(async (key: string) => (object && key === OBJECT_KEY ? object : null)),
    delete: vi.fn(async () => {})
  }
  return { storage }
}

/** A signed, path-safe token for the given claims (mirroring the link's `.`→`~` swap). */
async function tokenFor(claims: { objectKey: string; exp: number }) {
  return (await signFileToken(claims, SECRET)).replaceAll('.', '~')
}

/** Invoke the route with a `token` param. */
function request(route: APIRoute, token: string) {
  return route({ params: { token } } as unknown as Parameters<APIRoute>[0]) as Promise<Response>
}

describe('createFileRoute', () => {
  it('streams the object with the stored metadata and hardening headers for a valid token', async () => {
    const { storage } = stubStorage(STORED)
    const response = await request(
      createFileRoute({ storage, secret: SECRET }),
      await tokenFor({ objectKey: OBJECT_KEY, exp: inOneHour() })
    )

    expect(response.status).toBe(200)
    expect(response.body).toBe(STORED.body)
    // Content-Type is echoed from what the store persisted; the disposition is always built here as an
    // attachment from the stored filename, not taken from the token or the adapter.
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="quote.pdf"; filename*=UTF-8\'\'quote.pdf'
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('forces an attachment even when a custom store serves an HTML content-type (API-002)', async () => {
    // A conforming custom adapter can only supply a filename/content-type, never a disposition string,
    // so it can't undo the download-only guarantee by asking for `inline`.
    const { storage } = stubStorage({ body: new ReadableStream(), contentType: 'text/html', filename: 'evil.html' })
    const response = await request(
      createFileRoute({ storage, secret: SECRET }),
      await tokenFor({ objectKey: OBJECT_KEY, exp: inOneHour() })
    )

    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/)
    expect(response.headers.get('Content-Disposition')).not.toContain('inline')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('falls back to a generic octet-stream attachment when the store returns no metadata', async () => {
    const { storage } = stubStorage({ body: new ReadableStream() })
    const response = await request(
      createFileRoute({ storage, secret: SECRET }),
      await tokenFor({ objectKey: OBJECT_KEY, exp: inOneHour() })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="download"; filename*=UTF-8\'\'download'
    )
  })

  it('404s a tampered or unknown token', async () => {
    const { storage } = stubStorage(STORED)
    const response = await request(createFileRoute({ storage, secret: SECRET }), 'not~a~valid~token')
    expect(response.status).toBe(404)
  })

  it('404s a token signed with a different secret', async () => {
    const { storage } = stubStorage(STORED)
    const token = (await signFileToken({ objectKey: OBJECT_KEY, exp: inOneHour() }, 'other-secret')).replaceAll(
      '.',
      '~'
    )
    const response = await request(createFileRoute({ storage, secret: SECRET }), token)
    expect(response.status).toBe(404)
  })

  it('404s an expired token before touching storage', async () => {
    const { storage } = stubStorage(STORED)
    const expired = await tokenFor({ objectKey: OBJECT_KEY, exp: Math.floor(Date.now() / 1000) - 1 })
    const response = await request(createFileRoute({ storage, secret: SECRET }), expired)

    expect(response.status).toBe(404)
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('410s a valid token whose object is gone', async () => {
    const { storage } = stubStorage(null)
    const response = await request(
      createFileRoute({ storage, secret: SECRET }),
      await tokenFor({ objectKey: OBJECT_KEY, exp: inOneHour() })
    )
    expect(response.status).toBe(410)
  })

  it('throws at construction on a secret too short to be safe', () => {
    const { storage } = stubStorage(STORED)
    expect(() => createFileRoute({ storage, secret: 'short' })).toThrow(/at least 32 characters/)
  })
})

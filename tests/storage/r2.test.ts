import { R2Storage, type R2BucketLike } from '#storage/r2.js'
import { describe, expect, it, vi } from 'vitest'

/** A minimal in-memory R2 double recording the arguments each call receives. */
function stubBucket() {
  const puts: {
    key: string
    options: { httpMetadata: { contentType: string; contentDisposition: string }; customMetadata: { filename: string } }
  }[] = []
  const deleted: string[] = []
  const objects = new Map<
    string,
    {
      body: ReadableStream
      httpMetadata?: { contentType?: string; contentDisposition?: string }
      customMetadata?: { filename?: string }
    }
  >()
  const bucket: R2BucketLike = {
    put: vi.fn(async (key, _file, options) => {
      puts.push({ key, options })
      objects.set(key, {
        body: new ReadableStream(),
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata
      })
    }),
    get: vi.fn(async (key) => objects.get(key) ?? null),
    delete: vi.fn(async (key) => {
      deleted.push(key)
      objects.delete(key)
    })
  }
  return { bucket, puts, deleted, objects }
}

const file = new File(['data'], 'quote.pdf')

describe('R2Storage', () => {
  it('stores a file under the prefixed key with an attachment disposition', async () => {
    const { bucket, puts } = stubBucket()
    await new R2Storage({ bucket, prefix: 'uploads/' }).put('abc', file, {
      contentType: 'application/pdf',
      filename: 'quote.pdf'
    })

    expect(puts[0]!.key).toBe('uploads/abc')
    expect(puts[0]!.options.httpMetadata).toEqual({
      contentType: 'application/pdf',
      contentDisposition: 'attachment; filename="quote.pdf"; filename*=UTF-8\'\'quote.pdf'
    })
    expect(puts[0]!.options.customMetadata).toEqual({ filename: 'quote.pdf' })
  })

  it('strips control characters and neutralises quotes so the filename cannot break the header', async () => {
    const { bucket, puts } = stubBucket()
    await new R2Storage({ bucket }).put('abc', file, {
      contentType: 'application/pdf',
      filename: 'evil"\r\nX-Injected: 1.pdf'
    })

    const disposition = puts[0]!.options.httpMetadata.contentDisposition
    expect(disposition).toMatch(/^attachment;/)
    expect(disposition).not.toMatch(/[\r\n]/)
  })

  it('reads a stored object back with its download metadata, and null for an absent key', async () => {
    const { bucket } = stubBucket()
    const storage = new R2Storage({ bucket, prefix: 'uploads/' })
    await storage.put('abc', file, { contentType: 'application/pdf', filename: 'quote.pdf' })

    const object = await storage.get('abc')
    // The download route reads the filename/type from here now that the token is opaque, and builds the
    // attachment disposition itself.
    expect(object?.contentType).toBe('application/pdf')
    expect(object?.filename).toBe('quote.pdf')
    expect(await storage.get('missing')).toBeNull()
  })

  it('deletes by the prefixed key', async () => {
    const { bucket, deleted } = stubBucket()
    await new R2Storage({ bucket, prefix: 'uploads/' }).delete('abc')
    expect(deleted).toEqual(['uploads/abc'])
  })

  it('round-trips a put then get under a prefix (the file route resolves the same key)', async () => {
    const { bucket } = stubBucket()
    const storage = new R2Storage({ bucket, prefix: 'uploads/' })
    await storage.put('key-1', file, { contentType: 'application/pdf', filename: 'q.pdf' })
    expect(await storage.get('key-1')).not.toBeNull()
  })
})

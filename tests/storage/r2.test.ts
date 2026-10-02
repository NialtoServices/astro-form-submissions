import { R2Storage, type R2BucketLike } from '#storage/r2.js'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBucket } from '../support/memory-bucket.js'

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

  it('streams a known-length body into the bucket with the same download metadata as a file', async () => {
    const bucket = new MemoryBucket()
    const storage = new R2Storage({ bucket, prefix: 'uploads/' })
    const bytes = new TextEncoder().encode('streamed bytes')

    await storage.putStream('key-2', new Response(bytes).body!, {
      contentType: 'video/mp4',
      filename: 'clip.mp4',
      size: bytes.length
    })

    const stored = bucket.objects.get('uploads/key-2')
    expect(stored?.bytes).toEqual(bytes)
    expect(stored?.httpMetadata.contentType).toBe('video/mp4')
    expect((await storage.get('key-2'))?.filename).toBe('clip.mp4')
  })

  it('peeks the leading bytes, total size and stored type through one ranged read', async () => {
    const bucket = new MemoryBucket()
    const storage = new R2Storage({ bucket, prefix: 'uploads/' })
    bucket.seedPresignedUpload(
      'uploads/key-3',
      new TextEncoder().encode('%PDF-1.7 and the rest'),
      'application/pdf',
      'a.pdf'
    )
    const get = vi.spyOn(bucket, 'get')

    const peeked = await storage.peek('key-3', 8)

    expect(peeked).toEqual({
      size: 21,
      contentType: 'application/pdf',
      header: new TextEncoder().encode('%PDF-1.7')
    })
    expect(get).toHaveBeenCalledWith('uploads/key-3', { range: { offset: 0, length: 8 } })
    expect(await storage.peek('missing', 8)).toBeNull()
  })

  it('downloads a presigned upload under its decoded filename', async () => {
    const bucket = new MemoryBucket()
    const storage = new R2Storage({ bucket })
    bucket.seedPresignedUpload('key-4', new Uint8Array([1]), 'image/jpeg', 'Kitchen – before.jpg')

    expect((await storage.get('key-4'))?.filename).toBe('Kitchen – before.jpg')
  })

  it('falls back to no filename when the encoded one is malformed', async () => {
    const bucket = new MemoryBucket()
    bucket.objects.set('key-5', {
      bytes: new Uint8Array([1]),
      httpMetadata: { contentType: 'image/jpeg' },
      customMetadata: { 'filename-uri': '%E2%80' }
    })

    expect((await new R2Storage({ bucket }).get('key-5'))?.filename).toBeUndefined()
  })
})

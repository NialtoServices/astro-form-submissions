import { ObjectExistsError } from '#storage/object-exists-error.js'
import { R2Storage } from '#storage/r2.js'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const bytes = new TextEncoder().encode('%PDF-1.7 a quote for the garden')
const options = { contentType: 'application/pdf', filename: 'quote.pdf', size: bytes.length }

/** A fresh stream of `data`, as a request body arrives. */
function stream(data: Uint8Array<ArrayBuffer>): ReadableStream {
  return new Response(data).body as ReadableStream
}

/** Storage over the test bucket, under a prefix of its own so tests never share a key. */
function storage() {
  return new R2Storage({ bucket: env.UPLOADS, prefix: `${crypto.randomUUID()}/` })
}

describe('R2Storage on the Workers runtime', () => {
  it('stores a stream of its declared length, then refuses to replace it', async () => {
    const uploads = storage()

    await uploads.putStream('key', stream(bytes), options)
    const second = uploads.putStream('key', stream(new TextEncoder().encode('MZ'.padEnd(bytes.length, 'x'))), options)

    await expect(second).rejects.toBeInstanceOf(ObjectExistsError)
    const peeked = await uploads.peek('key', 8)
    expect(peeked?.size).toBe(bytes.length)
    expect(new TextDecoder().decode(peeked?.header)).toBe('%PDF-1.7')
  })

  it('refuses a stream that runs short or long of its declared length, storing nothing', async () => {
    const uploads = storage()

    // The local R2 simulator logs "Network connection lost" as an uncaught error when a write is cut short;
    // a bare bucket.put does the same, so the log is the simulator's, not the toolkit's.

    await expect(uploads.putStream('short', stream(bytes.slice(0, -1)), options)).rejects.toThrow()
    await expect(uploads.putStream('long', stream(new Uint8Array([...bytes, 0x20])), options)).rejects.toThrow()

    expect(await uploads.get('short')).toBeNull()
    expect(await uploads.get('long')).toBeNull()
  })

  it('claims a key once, and refuses to stream to it once its object is gone', async () => {
    const uploads = storage()
    await uploads.putStream('key', stream(bytes), options)

    expect(await uploads.claim('key')).toBe(true)
    expect(await uploads.claim('key')).toBe(false)

    await uploads.delete('key')
    await expect(uploads.putStream('key', stream(bytes), options)).rejects.toBeInstanceOf(ObjectExistsError)
    expect(await uploads.get('key')).toBeNull()
  })

  it('reads back the filename and type it stored', async () => {
    const uploads = storage()
    await uploads.putStream('key', stream(bytes), options)

    const stored = await uploads.get('key')

    expect(stored?.filename).toBe('quote.pdf')
    expect(stored?.contentType).toBe('application/pdf')
  })
})

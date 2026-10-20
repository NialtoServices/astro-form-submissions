import type { StandardSchemaV1 } from '@standard-schema/spec'
import { UploadedFiles } from '#enrichers/uploaded-files.js'
import { DOCX_TYPE } from '#files/matchers/zip.js'
import { ObjectExistsError } from '#storage/object-exists-error.js'
import { R2Storage } from '#storage/r2.js'
import { createUploadRoute } from '#uploads/upload-route.js'
import type { PendingUpload } from '#uploads/upload-target.js'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import bookXlsxURL from '../fixtures/files/book.xlsx?inline'
import cvDocxURL from '../fixtures/files/cv.docx?inline'
import { makeRouteContext } from '../support/harness.js'

const bytes = new TextEncoder().encode('%PDF-1.7 a quote for the garden')
const options = { contentType: 'application/pdf', filename: 'quote.pdf', size: bytes.length }

/** A fresh stream of `data`, as a request body arrives. */
function stream(data: Uint8Array<ArrayBuffer>): ReadableStream {
  return new Response(data).body as ReadableStream
}

const SECRET = 'a-sufficiently-long-signing-secret'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const schema: StandardSchemaV1<Record<string, unknown>, { name: string }> = {
  '~standard': { version: 1, vendor: 'test', validate: () => ({ value: { name: 'Ada' } }) }
}

/** The bytes of a fixture inlined by the bundler as a `data:` URL. */
function inlinedBytes(dataURL: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(dataURL.slice(dataURL.indexOf(',') + 1)), (character) => character.charCodeAt(0))
}

/**
 * Uploads `bytes` the way a direct upload does: the upload route admits the file and issues its receipt,
 * then the bytes land in storage under the admitted key, type and name.
 */
async function uploadDirectly(uploads: R2Storage, name: string, bytes: Uint8Array<ArrayBuffer>) {
  const prepared: PendingUpload[] = []
  const route = createUploadRoute({
    schema,
    secret: SECRET,
    accept: [DOCX_TYPE],
    target: {
      prepare: async (upload) => {
        prepared.push(upload)
        return { url: '/unused/', method: 'PUT', headers: {} }
      }
    }
  })
  const body = new FormData()
  body.set('uploads', JSON.stringify([{ name, size: bytes.length, type: DOCX }]))
  const response = await route(makeRouteContext({ body }))
  const { uploads: issued } = (await response.json()) as { uploads: { receipt: string }[] }
  const [upload] = prepared
  if (!upload || !issued[0]) throw new Error('The upload route admitted nothing.')

  await uploads.putStream(upload.objectKey, stream(bytes), {
    contentType: upload.contentType,
    filename: upload.filename,
    size: bytes.length
  })
  const data = new FormData()
  data.set('upload', issued[0].receipt)
  return {
    submission: { name: 'Ada' },
    data,
    requestURL: new URL('https://example.com/api/form'),
    siteURL: new URL('https://example.com/'),
    submittedAt: new Date('2026-10-20T10:00:00Z')
  }
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

  it('reads back the requested slice of a stored object, and null for a missing key', async () => {
    const uploads = storage()
    await uploads.putStream('key', stream(bytes), options)

    const slice = await uploads.readRange('key', 5, 3)
    const tail = await uploads.readRange('key', bytes.length - 6, 6)

    expect(new TextDecoder().decode(slice!)).toBe(new TextDecoder().decode(bytes.slice(5, 8)))
    expect(new TextDecoder().decode(tail!)).toBe('garden')
    expect(await uploads.readRange('absent', 0, 4)).toBeNull()
  })

  it('confirms a .docx uploaded directly through ranged reads of the stored object, and refuses a renamed .xlsx', async () => {
    const uploads = storage()
    const enricher = new UploadedFiles({
      storage: uploads,
      secret: SECRET,
      accept: [DOCX_TYPE],
      link: async (stored) => `https://example.com/files/${stored.objectKey}/`
    })

    const docx = await enricher.enrich(
      { name: 'Ada' },
      await uploadDirectly(uploads, 'cv.docx', inlinedBytes(cvDocxURL))
    )
    const renamed = await enricher.enrich(
      { name: 'Ada' },
      await uploadDirectly(uploads, 'cv.docx', inlinedBytes(bookXlsxURL))
    )

    expect(docx).toMatchObject({ provide: { files: [{ name: 'cv.docx' }] } })
    expect(renamed).toMatchObject({ reject: { key: 'fileType' }, code: 'uploaded-files.type-not-accepted' })
  })
})

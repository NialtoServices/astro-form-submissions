import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { EnrichmentContext } from '#enrichers/enricher.js'
import { UploadedFiles, type UploadedFilesOptions } from '#enrichers/uploaded-files.js'
import type { FilePayload } from '#files/signing.js'
import { R2Storage } from '#storage/r2.js'
import type { FileStorage } from '#storage/storage.js'
import { createUploadRoute } from '#uploads/upload-route.js'
import type { PendingUpload, UploadTarget } from '#uploads/upload-target.js'
import { WorkerUploadTarget } from '#uploads/worker-upload-target.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRouteContext } from '../support/harness.js'
import { MemoryBucket } from '../support/memory-bucket.js'

const SECRET = 'a-sufficiently-long-signing-secret'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj')
const TEXT = new TextEncoder().encode('just some plain text, not on the allow-list')

type Enquiry = { name: string }

const schema: StandardSchemaV1<Record<string, unknown>, Enquiry> = {
  '~standard': { version: 1, vendor: 'test', validate: () => ({ value: { name: 'Ada' } }) }
}

/** A file as the browser would describe it, with the bytes a presigned upload would then store. */
interface TestFile {
  name: string
  type: string
  bytes: Uint8Array<ArrayBuffer>
}

const photo: TestFile = { name: 'garden.jpg', type: 'image/jpeg', bytes: JPEG }
const quote: TestFile = { name: 'quote.pdf', type: 'application/pdf', bytes: PDF }

/**
 * Runs the real upload route for the given files and returns their receipts and admitted uploads,
 * so every receipt under test is one the route actually issued.
 */
async function admit(files: TestFile[], receiptTTLSeconds?: number) {
  const prepared: PendingUpload[] = []
  const target: UploadTarget = {
    prepare: async (upload) => {
      prepared.push(upload)
      return { url: '/unused/', method: 'PUT', headers: {} }
    }
  }
  const route = createUploadRoute({
    schema,
    target,
    secret: SECRET,
    receiptTTLSeconds,
    maxFileBytes: 1e9,
    maxTotalBytes: 1e9
  })

  const body = new FormData()
  body.set(
    'uploads',
    JSON.stringify(files.map((file) => ({ name: file.name, size: file.bytes.length, type: file.type })))
  )
  const response = await route(makeRouteContext({ body }))
  const { uploads } = (await response.json()) as { uploads: { receipt: string }[] }

  return { receipts: uploads.map((upload) => upload.receipt), prepared }
}

/** Stores each admitted file's bytes as a presigned upload would, under the storage's prefix. */
function store(bucket: MemoryBucket, prepared: PendingUpload[], files: TestFile[]) {
  prepared.forEach((upload, index) =>
    bucket.seedPresignedUpload(`uploads/${upload.objectKey}`, files[index]!.bytes, upload.contentType, upload.filename)
  )
}

function contextWith(receipts: string[]): EnrichmentContext<Enquiry> {
  const data = new FormData()
  for (const receipt of receipts) data.append('upload', receipt)
  return {
    submission: { name: 'Ada' },
    data,
    requestURL: new URL('https://example.com/api/contact/'),
    siteURL: new URL('https://example.com/'),
    submittedAt: new Date('2026-10-02T10:00:00Z'),
    report: vi.fn()
  }
}

function setup(overrides: Partial<UploadedFilesOptions<Enquiry>> = {}) {
  const bucket = new MemoryBucket()
  const storage = new R2Storage({ bucket, prefix: 'uploads/' })
  const link = vi.fn(async (stored: FilePayload) => `https://example.com/files/${stored.objectKey}/`)
  const enricher = new UploadedFiles<Enquiry>({ storage, secret: SECRET, link, ...overrides })
  return { bucket, storage, link, enricher }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UploadedFiles', () => {
  it('is a no-op when the submission carries no receipts', async () => {
    const { enricher, bucket } = setup()
    const get = vi.spyOn(bucket, 'get')

    expect(await enricher.enrich({ name: 'Ada' }, contextWith([]))).toEqual({})
    expect(get).not.toHaveBeenCalled()
  })

  it('links every verified upload, with its name, size and sniffed type', async () => {
    const { enricher, bucket, link } = setup()
    const { receipts, prepared } = await admit([photo, quote])
    store(bucket, prepared, [photo, quote])

    const result = await enricher.enrich({ name: 'Ada' }, contextWith(receipts))

    expect(result).toMatchObject({
      provide: {
        files: [
          { name: 'garden.jpg', url: `https://example.com/files/${prepared[0]!.objectKey}/`, size: JPEG.length },
          { name: 'quote.pdf', url: `https://example.com/files/${prepared[1]!.objectKey}/`, size: PDF.length }
        ]
      }
    })
    expect(link.mock.calls.map(([stored]) => stored)).toEqual([
      { objectKey: prepared[0]!.objectKey, filename: 'garden.jpg', contentType: 'image/jpeg' },
      { objectKey: prepared[1]!.objectKey, filename: 'quote.pdf', contentType: 'application/pdf' }
    ])
  })

  it('accepts bytes stored as opaque, linking them under their sniffed type', async () => {
    const { enricher, bucket, link } = setup()
    const unnamed = { ...photo, type: '' }
    const { receipts, prepared } = await admit([unnamed])
    store(bucket, prepared, [unnamed])

    expect(prepared[0]!.contentType).toBe('application/octet-stream')
    expect(await enricher.enrich({ name: 'Ada' }, contextWith(receipts))).toHaveProperty('provide')
    expect(link.mock.calls[0]![0].contentType).toBe('image/jpeg')
  })

  it('links a file named by duplicate receipts once', async () => {
    const { enricher, bucket } = setup()
    const { receipts, prepared } = await admit([photo])
    store(bucket, prepared, [photo])

    const result = await enricher.enrich({ name: 'Ada' }, contextWith([receipts[0]!, receipts[0]!]))

    expect((result as { provide: { files: unknown[] } }).provide.files).toHaveLength(1)
  })

  it('deletes every object on rollback', async () => {
    const { enricher, bucket } = setup()
    const { receipts, prepared } = await admit([photo, quote])
    store(bucket, prepared, [photo, quote])

    const result = await enricher.enrich({ name: 'Ada' }, contextWith(receipts))
    await (result as { rollback: () => Promise<void> }).rollback()

    expect(bucket.objects.size).toBe(0)
  })

  describe('refusals, which delete everything the submission referenced', () => {
    const expectRefused = async (result: unknown, key: string, bucket: MemoryBucket) => {
      expect(result).toMatchObject({ reject: { key } })
      expect(bucket.objects.size).toBe(0)
    }

    it('refuses a tampered receipt, deleting what the valid receipts identify', async () => {
      const { enricher, bucket } = setup()
      const { receipts, prepared } = await admit([photo, quote])
      store(bucket, prepared, [photo, quote])

      const result = await enricher.enrich({ name: 'Ada' }, contextWith([receipts[0]!, `${receipts[1]}x`]))

      // A tampered receipt names no trustworthy key, so its object is left to the bucket's lifecycle rule.
      expect(result).toMatchObject({ reject: { key: 'uploadMissing' } })
      expect([...bucket.objects.keys()]).toEqual([`uploads/${prepared[1]!.objectKey}`])
    })

    it('refuses an expired receipt', async () => {
      const { enricher, bucket } = setup()
      const { receipts, prepared } = await admit([photo], 60)
      store(bucket, prepared, [photo])

      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 61_000)
      const result = await enricher.enrich({ name: 'Ada' }, contextWith(receipts))

      expect(result).toMatchObject({ reject: { key: 'uploadMissing' } })
    })

    it('refuses an upload grant or a receipt from another secret presented as a receipt', async () => {
      const { enricher } = setup()
      const upload = { objectKey: 'k', filename: 'a.jpg', size: JPEG.length, contentType: 'image/jpeg' }
      const grant = (await new WorkerUploadTarget({ secret: SECRET, basePath: '/up' }).prepare(upload)).url
        .split('/')[2]!
        .replaceAll('~', '.')

      expect(await enricher.enrich({ name: 'Ada' }, contextWith([grant]))).toMatchObject({
        reject: { key: 'uploadMissing' }
      })
    })

    it('refuses an object that never arrived', async () => {
      const { enricher, bucket } = setup()
      const { receipts, prepared } = await admit([photo, quote])
      store(bucket, prepared.slice(0, 1), [photo])

      await expectRefused(await enricher.enrich({ name: 'Ada' }, contextWith(receipts)), 'uploadMissing', bucket)
    })

    it('refuses an object whose size differs from its receipt', async () => {
      const { enricher, bucket } = setup()
      const { receipts, prepared } = await admit([photo])
      bucket.seedPresignedUpload(
        `uploads/${prepared[0]!.objectKey}`,
        new Uint8Array([...JPEG, 0]),
        'image/jpeg',
        'garden.jpg'
      )

      await expectRefused(await enricher.enrich({ name: 'Ada' }, contextWith(receipts)), 'uploadMissing', bucket)
    })

    it('refuses bytes that match nothing accepted', async () => {
      const { enricher, bucket } = setup()
      const notes = { name: 'notes.pdf', type: 'application/pdf', bytes: TEXT }
      const { receipts, prepared } = await admit([notes])
      store(bucket, prepared, [notes])

      await expectRefused(await enricher.enrich({ name: 'Ada' }, contextWith(receipts)), 'fileType', bucket)
    })

    it('refuses bytes that contradict the type they were stored with', async () => {
      const { enricher, bucket } = setup()
      const disguised = { name: 'photo.pdf', type: 'application/pdf', bytes: JPEG }
      const { receipts, prepared } = await admit([disguised])
      store(bucket, prepared, [disguised])

      await expectRefused(await enricher.enrich({ name: 'Ada' }, contextWith(receipts)), 'fileType', bucket)
    })

    it('re-checks the count and size limits against the receipts', async () => {
      const tooMany = setup({ maxFiles: 1 })
      const tooLarge = setup({ maxTotalBytes: JPEG.length + 1 })
      const first = await admit([photo, quote])
      const second = await admit([photo, quote])
      store(tooMany.bucket, first.prepared, [photo, quote])
      store(tooLarge.bucket, second.prepared, [photo, quote])

      await expectRefused(
        await tooMany.enricher.enrich({ name: 'Ada' }, contextWith(first.receipts)),
        'tooManyFiles',
        tooMany.bucket
      )
      await expectRefused(
        await tooLarge.enricher.enrich({ name: 'Ada' }, contextWith(second.receipts)),
        'fileTooLarge',
        tooLarge.bucket
      )
    })

    it('reports a storage failure, cleans up, and fails with the send error', async () => {
      const { bucket, storage } = setup()
      const failure = new Error('bucket unavailable')
      const { receipts, prepared } = await admit([photo])
      store(bucket, prepared, [photo])
      const failing: FileStorage = {
        put: storage.put.bind(storage),
        get: storage.get.bind(storage),
        delete: storage.delete.bind(storage),
        peek: async () => {
          throw failure
        }
      }
      const enricher = new UploadedFiles<Enquiry>({ storage: failing, secret: SECRET, link: async () => '' })
      const context = contextWith(receipts)

      const result = await enricher.enrich({ name: 'Ada' }, context)

      expect(result).toMatchObject({ reject: { key: 'send', status: 502 } })
      expect(context.report).toHaveBeenCalledWith(failure)
      expect(bucket.objects.size).toBe(0)
    })
  })

  it('refuses to construct over a storage that cannot peek, or with a short secret', () => {
    const storage: FileStorage = { put: async () => {}, get: async () => null, delete: async () => {} }
    expect(() => new UploadedFiles({ storage, secret: SECRET, link: async () => '' })).toThrow('peek')
    expect(() => setup({ secret: 'short' })).toThrow('at least 32')
  })
})

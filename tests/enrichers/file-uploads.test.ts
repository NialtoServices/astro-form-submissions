import type { EnrichmentContext } from '#enrichers/enricher.js'
import { FileUploads } from '#enrichers/file-uploads.js'
import type { FileStorage } from '#storage/storage.js'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { browserFilename, expectSafeStoredName } from '../support/filenames.js'

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]

/** A File with real magic bytes and a chosen size (padded with zeros). */
function upload(name: string, header: number[], bytes = 512): File {
  const buffer = new Uint8Array(Math.max(bytes, header.length))
  buffer.set(header)
  return new File([buffer], name)
}

/** A recording storage double. */
function stubStorage(putBehaviour?: (key: string) => void) {
  const put = vi.fn(async (key: string, _file: File, _options: { contentType: string; filename: string }) =>
    putBehaviour?.(key)
  )
  const deleted: string[] = []
  const deleteObject = vi.fn(async (key: string) => void deleted.push(key))
  const storage: FileStorage = { put, get: vi.fn(async () => null), delete: deleteObject }
  return { storage, put, deleteObject, deleted }
}

// The submission is only the validated input; uploaded-file links are exposed on `context.resources`.
type Enquiry = { name: string }

/** Build an enrichment context whose form data carries the given files under `field`. */
function contextWith(files: File[], field = 'file'): EnrichmentContext<Enquiry> {
  const data = new FormData()
  for (const file of files) data.append(field, file)
  return {
    submission: { name: 'Ada' },
    data,
    requestURL: new URL('https://example.com/api/form'),
    siteURL: new URL('https://example.com/'),
    submittedAt: new Date('2026-01-02T03:04:05Z'),
    report: vi.fn()
  }
}

function uploader(storage: FileStorage, overrides: Partial<Parameters<typeof makeOptions>[1]> = {}) {
  return new FileUploads<Enquiry>(makeOptions(storage, overrides))
}

function makeOptions(storage: FileStorage, overrides: Record<string, unknown> = {}) {
  return {
    storage,
    link: async (stored: { objectKey: string }) => `https://example.com/files/${stored.objectKey}/`,
    attachTo: 'files',
    ...overrides
  } as ConstructorParameters<typeof FileUploads<Enquiry>>[0]
}

describe('FileUploads', () => {
  it('is a no-op when no files are attached, touching storage not at all', async () => {
    const { storage, put } = stubStorage()
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith([]))

    expect(result).toEqual({})
    expect(put).not.toHaveBeenCalled()
  })

  it('ignores empty zero-byte file parts', async () => {
    const { storage, put } = stubStorage()
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith([new File([], 'empty.png')]))

    expect(result).toEqual({})
    expect(put).not.toHaveBeenCalled()
  })

  it('rejects when more than maxFiles are attached', async () => {
    const { storage } = stubStorage()
    const files = [1, 2, 3].map((fileNumber) => upload(`f${fileNumber}.pdf`, PDF_HEADER))
    const result = await uploader(storage, { maxFiles: 2 }).enrich({ name: 'Ada' }, contextWith(files))

    expect(result).toEqual({
      reject: FileUploads.errors.tooManyFiles,
      code: 'file-uploads.too-many',
      details: { count: 3, limit: 2 }
    })
  })

  it('rejects a file over the per-file size limit', async () => {
    const { storage } = stubStorage()
    const result = await uploader(storage, { maxFileBytes: 256 }).enrich(
      { name: 'Ada' },
      contextWith([upload('big.pdf', PDF_HEADER, 512)])
    )
    expect(result).toEqual({
      reject: FileUploads.errors.fileTooLarge,
      code: 'file-uploads.too-large',
      details: { size: 512, limit: 256 }
    })
  })

  it('rejects when the combined size exceeds the total limit', async () => {
    const { storage } = stubStorage()
    const files = [upload('a.pdf', PDF_HEADER, 400), upload('b.pdf', PDF_HEADER, 400)]
    const result = await uploader(storage, { maxTotalBytes: 600 }).enrich({ name: 'Ada' }, contextWith(files))

    expect(result).toEqual({
      reject: FileUploads.errors.fileTooLarge,
      code: 'file-uploads.total-too-large',
      details: { total: 800, limit: 600 }
    })
  })

  it('rejects a file whose magic bytes are not on the allow-list', async () => {
    const { storage } = stubStorage()
    const notAllowed = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'mystery.bin')
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith([notAllowed]))

    expect(result).toEqual({ reject: FileUploads.errors.fileType, code: 'file-uploads.type-not-accepted' })
  })

  it('stores each file and provides the resolved links as a resource', async () => {
    const { storage, put } = stubStorage()
    const files = [upload('quote.pdf', PDF_HEADER), upload('photo.png', PNG_HEADER)]
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith(files))

    const storedKeys = put.mock.calls.map((call) => (call as unknown[])[0])
    expect('provide' in result && result.provide).toEqual({
      files: [
        {
          name: 'quote.pdf',
          url: expect.stringMatching(/^https:\/\/example\.com\/files\/.+\/$/),
          size: 512,
          key: storedKeys[0]
        },
        {
          name: 'photo.png',
          url: expect.stringMatching(/^https:\/\/example\.com\/files\/.+\/$/),
          size: 512,
          key: storedKeys[1]
        }
      ]
    })
    expect(put).toHaveBeenCalledTimes(2)

    // The sniffed content-type is stored, not the (absent) client MIME.
    expect(put.mock.calls[0]![2]).toEqual({ contentType: 'application/pdf', filename: 'quote.pdf' })
    expect(put.mock.calls[1]![2]).toEqual({ contentType: 'image/png', filename: 'photo.png' })
  })

  it('strips control characters and quotes from a stored filename', async () => {
    const { storage, put } = stubStorage()
    await uploader(storage).enrich(
      { name: 'Ada' },
      contextWith([upload('a"b\r\n\u0000\t\u001b\u007f\u0085c.pdf', PDF_HEADER)])
    )

    expect(put.mock.calls[0]![2]).toEqual({ contentType: 'application/pdf', filename: 'abc.pdf' })
  })

  it("names a file whose name is only stripped characters `upload`, with its type's extension", async () => {
    const { storage, put } = stubStorage()
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith([upload('"\r\n', PDF_HEADER)]))

    expect(put.mock.calls[0]![2]).toEqual({ contentType: 'application/pdf', filename: 'upload.pdf' })
    expect('provide' in result && result.provide?.files[0]?.name).toBe('upload.pdf')
  })

  it("appends the checked type's extension to a name that claims another, in storage and in the link", async () => {
    const { storage, put } = stubStorage()
    const result = await uploader(storage).enrich(
      { name: 'Ada' },
      contextWith([upload('invoice.js', PDF_HEADER), upload('Quote.PDF', PDF_HEADER)])
    )

    expect(put.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
      { contentType: 'application/pdf', filename: 'invoice.js.pdf' },
      { contentType: 'application/pdf', filename: 'Quote.PDF' }
    ])
    expect('provide' in result && result.provide?.files.map((file) => file.name)).toEqual([
      'invoice.js.pdf',
      'Quote.PDF'
    ])
  })

  it("keeps a long name within 200 characters when it appends the type's extension, and stable when named again", async () => {
    const { storage, put } = stubStorage()
    await uploader(storage).enrich({ name: 'Ada' }, contextWith([upload('a'.repeat(300), PDF_HEADER)]))
    const stored = (put.mock.calls[0]![2] as { filename: string }).filename

    const again = stubStorage()
    await uploader(again.storage).enrich({ name: 'Ada' }, contextWith([upload(stored, PDF_HEADER)]))

    expect(stored).toBe(`${'a'.repeat(196)}.pdf`)
    expect((again.put.mock.calls[0]![2] as { filename: string }).filename).toBe(stored)
  })

  it("stores and links a safe name for any filename a browser reports, ending in the checked type's extension", async () => {
    await fc.assert(
      fc.asyncProperty(browserFilename, async (name) => {
        const { storage, put } = stubStorage()
        const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith([upload(name, PDF_HEADER)]))
        const stored = (put.mock.calls[0]![2] as { filename: string }).filename

        expectSafeStoredName(stored)
        expect(stored.toLowerCase().endsWith('.pdf')).toBe(true)
        expect('provide' in result && result.provide?.files[0]?.name).toBe(stored)
      }),
      { numRuns: 1000 }
    )
  })

  it('names a re-upload of a stored file exactly as it was stored', async () => {
    const storedName = async (name: string) => {
      const { storage, put } = stubStorage()
      await uploader(storage).enrich({ name: 'Ada' }, contextWith([upload(name, PDF_HEADER)]))
      return (put.mock.calls[0]![2] as { filename: string }).filename
    }

    await fc.assert(
      fc.asyncProperty(browserFilename, async (name) => {
        const stored = await storedName(name)

        expect(await storedName(stored)).toBe(stored)
      }),
      { numRuns: 1000 }
    )
  })

  it('rolls back its own uploads and rejects `send` when a later upload fails', async () => {
    let call = 0
    const { storage, deleted } = stubStorage(() => {
      call += 1
      if (call === 2) throw new Error('R2 down')
    })
    const files = [upload('a.pdf', PDF_HEADER), upload('b.pdf', PDF_HEADER)]
    const context = contextWith(files)
    const result = await uploader(storage).enrich({ name: 'Ada' }, context)

    expect(result).toEqual({ reject: FileUploads.errors.uploadFailed, code: 'file-uploads.store-failed' })

    // Every attempted key is cleaned up (keys are tracked before `put`, so a write that committed
    // but lost its ack is still deleted); no rollback is returned to the route.
    expect(deleted.length).toBeGreaterThanOrEqual(1)
    expect('rollback' in result).toBe(false)
    expect(context.report).toHaveBeenCalledOnce()
  })

  it('contains a throwing link resolver, cleaning up and rejecting', async () => {
    const { storage, deleted } = stubStorage()
    const uploaderWithBadLink = new FileUploads<Enquiry>(
      makeOptions(storage, {
        link: () => {
          throw new Error('link blew up')
        }
      })
    )
    const context = contextWith([upload('a.pdf', PDF_HEADER)])
    const result = await uploaderWithBadLink.enrich({ name: 'Ada' }, context)

    expect(result).toEqual({ reject: FileUploads.errors.uploadFailed, code: 'file-uploads.store-failed' })
    expect(deleted).toHaveLength(1)
    expect(context.report).toHaveBeenCalled()
  })

  it('reports the keys it could not delete during rollback', async () => {
    const deleteObject = vi.fn().mockRejectedValue(new Error('R2 unavailable'))
    const put = vi.fn(async () => {})
    const storage: FileStorage = { put, get: vi.fn(async () => null), delete: deleteObject }
    const context = contextWith([upload('a.pdf', PDF_HEADER)])
    const result = await uploader(storage).enrich({ name: 'Ada' }, context)

    if (!('rollback' in result) || !result.rollback) throw new Error('expected a rollback')
    await result.rollback()
    const storedKey = (put.mock.calls[0] as unknown[])[0]
    expect(context.report).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'storage.delete-failed',
        message: expect.stringContaining('Failed to delete'),
        details: { keys: [storedKey] }
      })
    )
  })

  it('returns a rollback that deletes every stored object and swallows delete errors', async () => {
    const deleteObject = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined)
    const storage: FileStorage = { put: vi.fn(async () => {}), get: vi.fn(async () => null), delete: deleteObject }
    const files = [upload('a.pdf', PDF_HEADER), upload('b.pdf', PDF_HEADER)]
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith(files))

    if (!('rollback' in result) || !result.rollback) throw new Error('expected a rollback')
    await expect(result.rollback()).resolves.toBeUndefined()
    expect(deleteObject).toHaveBeenCalledTimes(2)
  })

  it.each(['/files/token/', 'javascript:alert(1)', ''])(
    'fails the upload, rolling back, when the link builder returns %j',
    async (relative) => {
      const { storage, put } = stubStorage()
      const context = contextWith([upload('quote.pdf', PDF_HEADER)])

      const result = await uploader(storage, { link: async () => relative }).enrich({ name: 'Ada' }, context)

      expect(result).toMatchObject({ reject: { key: 'send' }, code: 'file-uploads.store-failed' })
      expect(context.report).toHaveBeenCalledWith(expect.objectContaining({ code: 'file-link.invalid-url' }))
      expect(put).toHaveBeenCalledOnce()
      expect(storage.delete).toHaveBeenCalledOnce()
    }
  )

  it('stores nothing when a later file fails validation', async () => {
    const mismatched = stubStorage()
    const oversized = stubStorage()

    const typeResult = await uploader(mismatched.storage).enrich(
      { name: 'Ada' },
      contextWith([upload('quote.pdf', PDF_HEADER), upload('mystery.bin', [0x00, 0x01, 0x02])])
    )
    const totalResult = await uploader(oversized.storage, { maxTotalBytes: 1_000 }).enrich(
      { name: 'Ada' },
      contextWith([upload('quote.pdf', PDF_HEADER, 600), upload('photo.png', PNG_HEADER, 600)])
    )

    expect(typeResult).toMatchObject({ code: 'file-uploads.type-not-accepted' })
    expect(mismatched.put).not.toHaveBeenCalled()
    expect(totalResult).toMatchObject({ code: 'file-uploads.total-too-large' })
    expect(oversized.put).not.toHaveBeenCalled()
  })

  it('reads files from a custom field name', async () => {
    const { storage, put } = stubStorage()
    const result = await uploader(storage, { field: 'attachment' }).enrich(
      { name: 'Ada' },
      contextWith([upload('quote.pdf', PDF_HEADER)], 'attachment')
    )
    expect('provide' in result).toBe(true)
    expect(put).toHaveBeenCalledOnce()
  })
})

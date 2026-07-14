import { type EnrichmentContext } from '#enrichers/enricher.js'
import { FileUploads } from '#enrichers/file-uploads.js'
import { type FileStorage } from '#storage/storage.js'
import { describe, expect, it, vi } from 'vitest'

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
  const del = vi.fn(async (key: string) => void deleted.push(key))
  const storage: FileStorage = { put, get: vi.fn(async () => null), delete: del }
  return { storage, put, del, deleted }
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
    const files = [1, 2, 3].map((n) => upload(`f${n}.pdf`, PDF_HEADER))
    const result = await uploader(storage, { maxFiles: 2 }).enrich({ name: 'Ada' }, contextWith(files))

    expect(result).toEqual({ reject: FileUploads.errors.tooManyFiles })
  })

  it('rejects a file over the per-file size limit', async () => {
    const { storage } = stubStorage()
    const result = await uploader(storage, { maxFileBytes: 256 }).enrich(
      { name: 'Ada' },
      contextWith([upload('big.pdf', PDF_HEADER, 512)])
    )
    expect(result).toEqual({ reject: FileUploads.errors.fileTooLarge })
  })

  it('rejects when the combined size exceeds the total limit', async () => {
    const { storage } = stubStorage()
    const files = [upload('a.pdf', PDF_HEADER, 400), upload('b.pdf', PDF_HEADER, 400)]
    const result = await uploader(storage, { maxTotalBytes: 600 }).enrich({ name: 'Ada' }, contextWith(files))

    expect(result).toEqual({ reject: FileUploads.errors.fileTooLarge })
  })

  it('rejects a file whose magic bytes are not on the allow-list', async () => {
    const { storage } = stubStorage()
    const notAllowed = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'mystery.bin')
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith([notAllowed]))

    expect(result).toEqual({ reject: FileUploads.errors.fileType })
  })

  it('stores each file and provides the resolved links as a resource', async () => {
    const { storage, put } = stubStorage()
    const files = [upload('quote.pdf', PDF_HEADER), upload('photo.png', PNG_HEADER)]
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith(files))

    expect('provide' in result && result.provide).toEqual({
      files: [
        { name: 'quote.pdf', url: expect.stringMatching(/^https:\/\/example\.com\/files\/.+\/$/), size: 512 },
        { name: 'photo.png', url: expect.stringMatching(/^https:\/\/example\.com\/files\/.+\/$/), size: 512 }
      ]
    })
    expect(put).toHaveBeenCalledTimes(2)
    // The sniffed content-type is stored, not the (absent) client MIME.
    expect(put.mock.calls[0]![2]).toEqual({ contentType: 'application/pdf', filename: 'quote.pdf' })
    expect(put.mock.calls[1]![2]).toEqual({ contentType: 'image/png', filename: 'photo.png' })
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

    expect(result).toEqual({ reject: FileUploads.errors.uploadFailed })
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

    expect(result).toEqual({ reject: FileUploads.errors.uploadFailed })
    expect(deleted).toHaveLength(1)
    expect(context.report).toHaveBeenCalled()
  })

  it('reports the keys it could not delete during rollback', async () => {
    const del = vi.fn().mockRejectedValue(new Error('R2 unavailable'))
    const storage: FileStorage = { put: vi.fn(async () => {}), get: vi.fn(async () => null), delete: del }
    const context = contextWith([upload('a.pdf', PDF_HEADER)])
    const result = await uploader(storage).enrich({ name: 'Ada' }, context)

    if (!('rollback' in result) || !result.rollback) throw new Error('expected a rollback')
    await result.rollback()
    expect(context.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Failed to delete') })
    )
  })

  it('returns a rollback that deletes every stored object and swallows delete errors', async () => {
    const del = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined)
    const storage: FileStorage = { put: vi.fn(async () => {}), get: vi.fn(async () => null), delete: del }
    const files = [upload('a.pdf', PDF_HEADER), upload('b.pdf', PDF_HEADER)]
    const result = await uploader(storage).enrich({ name: 'Ada' }, contextWith(files))

    if (!('rollback' in result) || !result.rollback) throw new Error('expected a rollback')
    await expect(result.rollback()).resolves.toBeUndefined()
    expect(del).toHaveBeenCalledTimes(2)
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

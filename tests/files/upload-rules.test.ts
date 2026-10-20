import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { EnrichmentContext } from '#enrichers/enricher.js'
import { FileUploads } from '#enrichers/file-uploads.js'
import { UploadedFiles } from '#enrichers/uploaded-files.js'
import {
  createUploadRoute,
  describeUploadRules,
  FILE_TYPES,
  IMAGE_TYPES,
  uploadInputAttributes,
  uploadRules,
  WORD_TYPES,
  type UploadRules
} from '#index.js'
import { R2Storage } from '#storage/r2.js'
import type { FileStorage } from '#storage/storage.js'
import type { UploadTarget } from '#uploads/upload-target.js'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { makeRouteContext } from '../support/harness.js'
import { MemoryBucket } from '../support/memory-bucket.js'

const MB = 1024 * 1024
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]

type Enquiry = { name: string }

const schema: StandardSchemaV1<Record<string, unknown>, Enquiry> = {
  '~standard': { version: 1, vendor: 'test', validate: () => ({ value: { name: 'Ada' } }) }
}

const quoteUploads = uploadRules({
  maxFiles: 2,
  maxFileBytes: 1000,
  maxTotalBytes: 1500,
  accept: [FILE_TYPES.pdf],
  required: true
})

function pdf(name: string, bytes: number): File {
  const buffer = new Uint8Array(bytes)
  buffer.set(PDF_HEADER)
  return new File([buffer], name)
}

function contextWith(files: File[]): EnrichmentContext<Enquiry> {
  const data = new FormData()
  for (const file of files) data.append('file', file)
  return {
    submission: { name: 'Ada' },
    data,
    requestURL: new URL('https://example.com/api/form'),
    siteURL: new URL('https://example.com/'),
    submittedAt: new Date('2026-01-02T03:04:05Z'),
    report: vi.fn()
  }
}

const storage: FileStorage = { put: vi.fn(async () => {}), get: vi.fn(async () => null), delete: vi.fn(async () => {}) }
const link = async () => 'https://example.com/files/key/'

describe('uploadRules', () => {
  it('spreads into FileUploads, UploadedFiles and createUploadRoute, which then refuse past the rules', async () => {
    const uploads = new FileUploads<Enquiry>({ ...quoteUploads, storage, link })

    expect(await uploads.enrich({ name: 'Ada' }, contextWith([]))).toMatchObject({
      reject: { key: 'fileRequired' }
    })
    expect(
      await uploads.enrich({ name: 'Ada' }, contextWith([pdf('a.pdf', 600), pdf('b.pdf', 600), pdf('c.pdf', 600)]))
    ).toMatchObject({ reject: { key: 'tooManyFiles' } })
    expect(await uploads.enrich({ name: 'Ada' }, contextWith([pdf('a.pdf', 1200)]))).toMatchObject({
      reject: { key: 'fileTooLarge' }
    })
    expect(await uploads.enrich({ name: 'Ada' }, contextWith([pdf('a.pdf', 900), pdf('b.pdf', 900)]))).toMatchObject({
      reject: { key: 'filesTooLarge' }
    })

    const receipts = new UploadedFiles<Enquiry>({
      ...quoteUploads,
      storage: new R2Storage({ bucket: new MemoryBucket() }),
      secret: 'a-sufficiently-long-signing-secret',
      link
    })
    expect(await receipts.enrich({ name: 'Ada' }, contextWith([]))).toMatchObject({ reject: { key: 'fileRequired' } })

    const target: UploadTarget = { prepare: async () => ({ url: '/unused/', method: 'PUT', headers: {} }) }
    const route = createUploadRoute({ ...quoteUploads, schema, target, secret: 'a-sufficiently-long-signing-secret' })
    const body = new FormData()
    body.set(
      'uploads',
      JSON.stringify([1, 2, 3].map((number) => ({ name: `${number}.pdf`, size: 100, type: 'application/pdf' })))
    )
    const response = await route(makeRouteContext({ body }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('no more than 2 files') })
  })

  it('takes a frozen accept list and hands back rules that cannot be changed', () => {
    expectTypeOf(quoteUploads).toExtend<Readonly<UploadRules>>()
    expect(Object.isFrozen(quoteUploads)).toBe(true)
    expect(Object.isFrozen(quoteUploads.accept)).toBe(true)
    expect(() => {
      ;(quoteUploads as UploadRules).maxFiles = 10
    }).toThrow(TypeError)
  })

  it('leaves no per-file limit when none is given, so a file may be as large as the total allows', async () => {
    const rules = uploadRules({ maxFiles: 3, maxTotalBytes: 50 * MB, accept: [FILE_TYPES.pdf] })
    const uploads = new FileUploads<Enquiry>({ ...rules, storage, link })

    const result = await uploads.enrich({ name: 'Ada' }, contextWith([pdf('plans.pdf', 12 * MB)]))

    expect(result).not.toHaveProperty('reject')
    expect(describeUploadRules(rules)).toBe('Up to 3 files, 50 MB in total. Accepted: PDF.')
  })

  it('refuses a per-file limit above the total', () => {
    expect(() =>
      uploadRules({ maxFiles: 2, maxFileBytes: 2 * MB, maxTotalBytes: MB, accept: [FILE_TYPES.pdf] })
    ).toThrow(/`maxFileBytes`.*at most.*`maxTotalBytes`/)
  })

  it('refuses limits that would silently stop limiting', () => {
    const accept = [FILE_TYPES.pdf]

    expect(() => uploadRules({ maxFiles: Number.NaN, maxTotalBytes: MB, accept })).toThrow(/`maxFiles`/)
    expect(() => uploadRules({ maxFiles: 1.5, maxTotalBytes: MB, accept })).toThrow(/`maxFiles`/)
    expect(() => uploadRules({ maxFiles: 2, maxFileBytes: 0, maxTotalBytes: MB, accept })).toThrow(/`maxFileBytes`/)
    expect(() => uploadRules({ maxFiles: 2, maxTotalBytes: -1, accept })).toThrow(/`maxTotalBytes`/)
  })
})

describe('uploadInputAttributes', () => {
  it('builds the input attributes from the rules', () => {
    const photosAndPDF = uploadRules({
      maxFiles: 5,
      maxFileBytes: 10 * MB,
      maxTotalBytes: 50 * MB,
      accept: [...IMAGE_TYPES, FILE_TYPES.pdf]
    })

    expect(uploadInputAttributes(photosAndPDF)).toEqual({
      accept:
        'image/avif,image/gif,image/heic,image/jpeg,image/png,image/webp,application/pdf,' +
        '.avif,.gif,.heic,.heif,.jpg,.jpeg,.jpe,.jfif,.png,.webp,.pdf',
      multiple: true,
      'data-astro-form-max-files': '5',
      'data-astro-form-max-file-bytes': String(10 * MB),
      'data-astro-form-max-total-bytes': String(50 * MB)
    })
  })

  it('marks a single required file as not multiple and gives the total as its per-file limit', () => {
    const attributes = uploadInputAttributes(
      uploadRules({ maxFiles: 1, maxTotalBytes: 5 * MB, accept: [FILE_TYPES.pdf], required: true })
    )

    expect(attributes).toEqual({
      accept: 'application/pdf,.pdf',
      required: true,
      'data-astro-form-max-files': '1',
      'data-astro-form-max-file-bytes': String(5 * MB),
      'data-astro-form-max-total-bytes': String(5 * MB)
    })
  })

  it('lists a content type or extension once however many matchers share it', () => {
    const twinPDF = { ...FILE_TYPES.pdf }
    const attributes = uploadInputAttributes(
      uploadRules({ maxFiles: 1, maxTotalBytes: MB, accept: [FILE_TYPES.pdf, twinPDF] })
    )

    expect(attributes.accept).toBe('application/pdf,.pdf')
  })

  it('names only content types for a matcher that has no extensions', () => {
    const custom = { contentType: 'application/x-custom', test: () => true }
    const attributes = uploadInputAttributes(uploadRules({ maxFiles: 1, maxTotalBytes: MB, accept: [custom] }))

    expect(attributes.accept).toBe('application/x-custom')
  })
})

describe('describeUploadRules', () => {
  it('writes a default hint for many files with a limit each and in total', () => {
    const rules = uploadRules({
      maxFiles: 5,
      maxFileBytes: 10 * MB,
      maxTotalBytes: 50 * MB,
      accept: [FILE_TYPES.jpeg, FILE_TYPES.png, FILE_TYPES.pdf]
    })

    expect(describeUploadRules(rules)).toBe('Up to 5 files, 10 MB each, 50 MB in total. Accepted: JPEG, PNG or PDF.')
  })

  it('writes a default hint for many files with only a total', () => {
    const rules = uploadRules({ maxFiles: 3, maxTotalBytes: 20 * MB, accept: [FILE_TYPES.pdf, ...WORD_TYPES] })

    expect(describeUploadRules(rules)).toBe('Up to 3 files, 20 MB in total. Accepted: PDF or Word.')
    expect(describeUploadRules(rules)).not.toMatch(/each/)
  })

  it('writes a default hint for a single file, bounded by the smaller of its limits', () => {
    const accept = [FILE_TYPES.pdf, ...WORD_TYPES]

    expect(
      describeUploadRules(uploadRules({ maxFiles: 1, maxFileBytes: 5 * MB, maxTotalBytes: 50 * MB, accept }))
    ).toBe('One file, up to 5 MB. Accepted: PDF or Word.')
    expect(describeUploadRules(uploadRules({ maxFiles: 1, maxTotalBytes: 8 * MB, accept }))).toBe(
      'One file, up to 8 MB. Accepted: PDF or Word.'
    )
  })

  it('names an unlabelled list as a supported file type', () => {
    const custom = { contentType: 'application/x-custom', test: () => true }

    expect(describeUploadRules(uploadRules({ maxFiles: 1, maxTotalBytes: MB, accept: [custom] }))).toBe(
      'One file, up to 1 MB. Accepted: a supported file type.'
    )
  })

  it("fills a site's own template from the rules", () => {
    const rules = uploadRules({
      maxFiles: 5,
      maxFileBytes: 10 * MB,
      maxTotalBytes: 50 * MB,
      accept: [FILE_TYPES.jpeg, FILE_TYPES.pdf]
    })

    expect(
      describeUploadRules(rules, 'Maximum {maxFiles} files of {maxFileSize} ({maxTotalSize} altogether): {types}')
    ).toBe('Maximum 5 files of 10 MB (50 MB altogether): JPEG or PDF')
  })

  it('reads a per-file token as the total when the rules set no per-file limit', () => {
    const rules = uploadRules({ maxFiles: 5, maxTotalBytes: 50 * MB, accept: [FILE_TYPES.pdf] })

    expect(describeUploadRules(rules, '{maxFileSize} each')).toBe('50 MB each')
  })
})

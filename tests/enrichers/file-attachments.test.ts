import type { EnrichmentContext } from '#enrichers/enricher.js'
import { DEFAULT_ATTACHMENT_TOTAL_BYTES, FileAttachments, type AttachedFile } from '#enrichers/file-attachments.js'
import { FILE_TYPES, uploadRules } from '#index.js'
import { describe, expect, it, vi } from 'vitest'
import { refusalBody } from '../support/refusals.js'

const MB = 1024 * 1024
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]

/** A File with real magic bytes and a chosen size (the rest is a counting pattern, so bytes can be compared). */
function upload(name: string, header: number[], bytes = 512): File {
  const buffer = new Uint8Array(Math.max(bytes, header.length)).map((_value, index) => index % 251)
  buffer.set(header)
  return new File([buffer], name)
}

type Enquiry = { name: string }

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

async function attached(result: Awaited<ReturnType<FileAttachments<Enquiry>['enrich']>>): Promise<AttachedFile[]> {
  if (!('provide' in result) || !result.provide) throw new Error('expected attached files')

  return result.provide.files
}

describe('FileAttachments', () => {
  it('provides an empty list when no files are attached', async () => {
    const result = await new FileAttachments<Enquiry>().enrich({ name: 'Ada' }, contextWith([]))

    expect(result).toEqual({ provide: { files: [] } })
  })

  it('ignores empty zero-byte file parts', async () => {
    const result = await new FileAttachments<Enquiry>().enrich(
      { name: 'Ada' },
      contextWith([new File([], 'empty.png')])
    )

    expect(result).toEqual({ provide: { files: [] } })
  })

  it('provides checked files without storing anything', async () => {
    const photo = upload('holiday"\r\nphoto.jpg', PNG_HEADER, 1000)
    const plans = upload('plans.pdf', PDF_HEADER, 600)
    const result = await new FileAttachments<Enquiry>().enrich({ name: 'Ada' }, contextWith([photo, plans]))
    const files = await attached(result)

    // The name is cleaned and carries the sniffed type's extension, whatever the browser claimed.
    expect(files.map(({ name, contentType, size }) => ({ name, contentType, size }))).toEqual([
      { name: 'holidayphoto.jpg.png', contentType: 'image/png', size: 1000 },
      { name: 'plans.pdf', contentType: 'application/pdf', size: 600 }
    ])
    expect(await files[0]!.bytes()).toEqual(new Uint8Array(await photo.arrayBuffer()))
    expect(await files[1]!.bytes()).toEqual(new Uint8Array(await plans.arrayBuffer()))
  })

  it('reads a file once, handing the same bytes to every caller', async () => {
    const result = await new FileAttachments<Enquiry>().enrich(
      { name: 'Ada' },
      contextWith([upload('a.pdf', PDF_HEADER)])
    )
    const [file] = await attached(result)

    expect(await file!.bytes()).toBe(await file!.bytes())
  })

  it('exposes the files under attachTo, and reads them from the named field', async () => {
    const attachments = new FileAttachments<Enquiry, 'attachments'>({ field: 'cv', attachTo: 'attachments' })
    const result = await attachments.enrich({ name: 'Ada' }, contextWith([upload('cv.pdf', PDF_HEADER)], 'cv'))

    expect('provide' in result && result.provide?.attachments.map((file) => file.name)).toEqual(['cv.pdf'])
  })

  it('has no rollback, since nothing is stored', async () => {
    const result = await new FileAttachments<Enquiry>().enrich(
      { name: 'Ada' },
      contextWith([upload('a.pdf', PDF_HEADER)])
    )

    expect(result).not.toHaveProperty('rollback')
  })

  it('defaults the total to 5 MB and refuses past it, keyed to the field', async () => {
    const attachments = new FileAttachments<Enquiry>({ field: 'cv' })
    const files = [upload('a.pdf', PDF_HEADER, 3 * MB), upload('b.pdf', PDF_HEADER, 3 * MB)]
    const result = await attachments.enrich({ name: 'Ada' }, contextWith(files, 'cv'))

    expect(DEFAULT_ATTACHMENT_TOTAL_BYTES).toBe(5 * MB)
    expect(attachments.maxTotalBytes).toBe(5 * MB)
    expect(result).toMatchObject({
      reject: { key: 'filesTooLarge', field: 'cv' },
      code: 'file-attachments.total-too-large',
      details: { total: 6 * MB, limit: 5 * MB }
    })
    expect((await refusalBody(result)).fieldErrors).toEqual({ cv: 'Your files add up to more than 5 MB.' })
  })

  it('refuses past the count, keyed to the field', async () => {
    const attachments = new FileAttachments<Enquiry>({ maxFiles: 2 })
    const files = [1, 2, 3].map((number) => upload(`f${number}.pdf`, PDF_HEADER))
    const result = await attachments.enrich({ name: 'Ada' }, contextWith(files))

    expect(result).toMatchObject({
      reject: { key: 'tooManyFiles', field: 'file' },
      code: 'file-attachments.too-many',
      details: { count: 3, limit: 2 }
    })
    expect((await refusalBody(result)).fieldErrors).toEqual({ file: 'Please attach no more than 2 files.' })
  })

  it('refuses a type that is not accepted, naming the accepted types', async () => {
    const attachments = new FileAttachments<Enquiry>({ accept: [FILE_TYPES.pdf] })
    const result = await attachments.enrich({ name: 'Ada' }, contextWith([upload('photo.png', PNG_HEADER)]))

    expect(result).toMatchObject({ reject: { key: 'fileType' }, code: 'file-attachments.type-not-accepted' })
    expect((await refusalBody(result)).fieldErrors).toEqual({
      file: 'That file type is not accepted. Please attach PDF.'
    })
  })

  it('refuses an empty field only when required', async () => {
    const result = await new FileAttachments<Enquiry>({ required: true }).enrich({ name: 'Ada' }, contextWith([]))

    expect(result).toMatchObject({ reject: { key: 'fileRequired', field: 'file' }, code: 'file-attachments.required' })
  })

  it('applies no per-file limit unless maxFileBytes is given, and honours it when it is', async () => {
    const large = upload('large.pdf', PDF_HEADER, 4 * MB)

    expect(await new FileAttachments<Enquiry>().enrich({ name: 'Ada' }, contextWith([large]))).not.toHaveProperty(
      'reject'
    )

    const limited = new FileAttachments<Enquiry>({ maxFileBytes: 2 * MB })
    const result = await limited.enrich({ name: 'Ada' }, contextWith([large]))

    expect(result).toMatchObject({
      reject: { key: 'fileTooLarge' },
      code: 'file-attachments.too-large',
      details: { size: 4 * MB, limit: 2 * MB }
    })
    expect((await refusalBody(result)).fieldErrors).toEqual({ file: 'Each file must be 2 MB or smaller.' })
  })

  it('takes upload rules by spread, which set no per-file limit beyond the total', async () => {
    const rules = uploadRules({ maxFiles: 2, maxTotalBytes: 2 * MB, accept: [FILE_TYPES.pdf], required: true })
    const attachments = new FileAttachments<Enquiry>({ ...rules })

    expect(attachments.maxTotalBytes).toBe(2 * MB)
    expect(await attachments.enrich({ name: 'Ada' }, contextWith([]))).toMatchObject({
      reject: { key: 'fileRequired' }
    })
    expect(
      await attachments.enrich({ name: 'Ada' }, contextWith([1, 2, 3].map((n) => upload(`${n}.pdf`, PDF_HEADER))))
    ).toMatchObject({ reject: { key: 'tooManyFiles' } })
    expect(
      await attachments.enrich(
        { name: 'Ada' },
        contextWith([upload('a.pdf', PDF_HEADER, 1.5 * MB), upload('b.pdf', PDF_HEADER, MB)])
      )
    ).toMatchObject({ reject: { key: 'filesTooLarge' } })
    expect(
      await attachments.enrich({ name: 'Ada' }, contextWith([upload('a.pdf', PDF_HEADER, 1.5 * MB)]))
    ).not.toHaveProperty('reject')
    expect(await attachments.enrich({ name: 'Ada' }, contextWith([upload('a.png', PNG_HEADER)]))).toMatchObject({
      reject: { key: 'fileType' }
    })
  })
})

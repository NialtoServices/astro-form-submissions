import { readFileSync } from 'node:fs'
import type { EnrichmentContext } from '#enrichers/enricher.js'
import { FileUploads } from '#enrichers/file-uploads.js'
import { DOC_TYPE } from '#files/matchers/ole.js'
import { RTF_TYPE } from '#files/matchers/rtf.js'
import { TEXT_TYPE } from '#files/matchers/text.js'
import { DOCX_TYPE, ODT_TYPE } from '#files/matchers/zip.js'
import { sniffType, type FileMatcher } from '#files/sniff.js'
import type { FileStorage } from '#storage/storage.js'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { documentLikeBytes } from '../support/document-bytes.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOC = 'application/msword'
const ODT = 'application/vnd.oasis.opendocument.text'
const RTF = 'application/rtf'
const TEXT = 'text/plain'

/** The document matchers in the order an allow-list checks them correctly: binary formats, then RTF, then text. */
const DOCUMENT_MATCHERS: FileMatcher[] = [DOCX_TYPE, DOC_TYPE, ODT_TYPE, RTF_TYPE, TEXT_TYPE]

/** A fixture's bytes, as `generate.py` beside it wrote them. */
function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(new URL(`../fixtures/files/${name}`, import.meta.url)))
}

/** A fixture as the browser would hand it over, under the name given. */
function fixtureFile(name: string, uploadedAs = name): File {
  return new File([fixture(name)], uploadedAs)
}

/** `bytes` with the archive comment its end-of-central-directory record carries replaced by `comment`. */
function withArchiveComment(bytes: Uint8Array, comment: Uint8Array): Uint8Array<ArrayBuffer> {
  const recordStart = bytes.length - 22
  const result = new Uint8Array(bytes.length + comment.length)
  result.set(bytes)
  new DataView(result.buffer).setUint16(recordStart + 20, comment.length, true)
  result.set(comment, bytes.length)
  return result
}

/** Deterministic noise, so a refusal of "random bytes" is the same refusal on every run. */
function noise(length: number): Uint8Array<ArrayBuffer> {
  let state = 0x2545f491
  return Uint8Array.from({ length }, () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state & 0xff
  })
}

describe('document types', () => {
  it('recognises Word documents however they were produced', async () => {
    for (const name of ['cv.docx', 'cv-libreoffice.docx', 'cv-with-comment.docx', 'cv-data-descriptor.docx']) {
      expect(await sniffType(fixtureFile(name), DOCUMENT_MATCHERS), name).toBe(DOCX)
    }

    for (const name of ['cv.doc', 'cv-word6.doc', 'cv-object-pool.doc']) {
      expect(await sniffType(fixtureFile(name), DOCUMENT_MATCHERS), name).toBe(DOC)
    }
  })

  it('refuses look-alikes', async () => {
    for (const name of [
      'cv.docm',
      'book.xlsx',
      'slides.pptx',
      'plain.zip',
      'book.xls',
      'book-with-document.xls',
      'slides.ppt',
      'sheet.ods',
      'template.ott',
      'truncated.docx'
    ]) {
      expect(await sniffType(fixtureFile(name), DOCUMENT_MATCHERS), name).toBeNull()
    }
  })

  it('refuses a renamed look-alike whatever its name says', async () => {
    expect(await sniffType(fixtureFile('book.xlsx', 'cv.docx'), DOCUMENT_MATCHERS)).toBeNull()
    expect(await sniffType(fixtureFile('slides.ppt', 'cv.doc'), DOCUMENT_MATCHERS)).toBeNull()
  })

  it('recognises ODT, RTF, text and Markdown', async () => {
    expect(await sniffType(fixtureFile('cv.odt'), DOCUMENT_MATCHERS)).toBe(ODT)
    expect(await sniffType(fixtureFile('cv.rtf'), DOCUMENT_MATCHERS)).toBe(RTF)
    expect(await sniffType(fixtureFile('notes.txt'), DOCUMENT_MATCHERS)).toBe(TEXT)
    expect(await sniffType(fixtureFile('notes.md'), DOCUMENT_MATCHERS)).toBe(TEXT)
  })

  it('names each type the way a hint shows it, and the extensions its files are saved under', () => {
    expect(DOCUMENT_MATCHERS.map(({ contentType, label, extensions }) => ({ contentType, label, extensions }))).toEqual(
      [
        { contentType: DOCX, label: 'Word', extensions: ['docx'] },
        { contentType: DOC, label: 'Word', extensions: ['doc'] },
        { contentType: ODT, label: 'OpenDocument', extensions: ['odt'] },
        { contentType: RTF, label: 'RTF', extensions: ['rtf'] },
        { contentType: TEXT, label: 'Text', extensions: ['txt', 'md'] }
      ]
    )
  })

  it('keeps a Markdown file its extension when storing it, and names unnamed text as text', async () => {
    const put = vi.fn(async (_key: string, _file: File, _options: { contentType: string; filename: string }) => {})
    const storage: FileStorage = { put, get: async () => null, delete: async () => {} }
    const enricher = new FileUploads({
      storage,
      accept: DOCUMENT_MATCHERS,
      link: async (stored) => `https://example.com/files/${stored.objectKey}/`
    })
    const data = new FormData()
    data.append('file', fixtureFile('notes.md'))
    data.append('file', fixtureFile('notes.txt', 'notes'))
    const context: EnrichmentContext<{ name: string }> = {
      submission: { name: 'Ada' },
      data,
      requestURL: new URL('https://example.com/api/form'),
      siteURL: new URL('https://example.com/'),
      submittedAt: new Date('2026-10-20T10:00:00Z')
    }

    await enricher.enrich({ name: 'Ada' }, context)

    expect(put.mock.calls.map(([, , options]) => options)).toEqual([
      { contentType: TEXT, filename: 'notes.md' },
      { contentType: TEXT, filename: 'notes.txt' }
    ])
  })

  it('refuses binary content dressed as text', async () => {
    expect(await sniffType(new File([noise(3 * 1024)], 'notes.txt'), DOCUMENT_MATCHERS)).toBeNull()
    expect(await sniffType(fixtureFile('utf16.txt'), DOCUMENT_MATCHERS)).toBeNull()
  })

  it('checks how a long text file ends as well as how it starts', async () => {
    const text = fixture('notes.txt')
    const withControlAtEnd = Uint8Array.from([...text.subarray(0, -1), 0x00])
    const withBrokenEnd = Uint8Array.from([...text, 0xc3])

    expect(await sniffType(new File([withControlAtEnd], 'notes.txt'), DOCUMENT_MATCHERS)).toBeNull()
    expect(await sniffType(new File([withBrokenEnd], 'notes.txt'), DOCUMENT_MATCHERS)).toBeNull()
  })

  it('refuses text whose only broken character straddles the end of the first 4 KiB', async () => {
    // A three-byte lead at the last byte of the first 4 KiB, followed by plain letters.
    const straddling = new TextEncoder().encode(`${'a'.repeat(4095)}\u20ac${'b'.repeat(2000)}`)
    straddling.set([0x41, 0x42], 4096)

    expect(await sniffType(new File([straddling], 'notes.txt'), DOCUMENT_MATCHERS)).toBeNull()
  })

  it('accepts tab, line and page breaks in text, and a byte-order mark', async () => {
    const text = new TextEncoder().encode('\uFEFFHeading\fColumn\tvalue\r\n')

    expect(await sniffType(new File([text], 'notes.txt'), DOCUMENT_MATCHERS)).toBe(TEXT)
  })

  it('refuses an empty file as text', async () => {
    expect(await sniffType(new File([], 'notes.txt'), DOCUMENT_MATCHERS)).toBeNull()
  })

  it('finds a Word archive index that starts before the end of the file it reads first', async () => {
    const docx = withArchiveComment(fixture('cv.docx'), new Uint8Array(32 * 1024 - 100).fill(0x20))

    expect(await sniffType(new File([docx], 'cv.docx'), DOCUMENT_MATCHERS)).toBe(DOCX)
  })

  it('refuses a Word archive whose index lies beyond what may be read', async () => {
    const docx = withArchiveComment(fixture('cv.docx'), new Uint8Array(60 * 1024).fill(0x20))

    expect(await sniffType(new File([docx], 'cv.docx'), DOCUMENT_MATCHERS)).toBeNull()
  })

  it('recognises an OpenDocument file after the Word check has read its whole index', async () => {
    const odt = withArchiveComment(fixture('cv.odt'), new Uint8Array(32 * 1024 - 100).fill(0x20))

    expect(await sniffType(new File([odt], 'cv.odt'), DOCUMENT_MATCHERS)).toBe(ODT)
  })

  it('refuses a Word 97-2003 file cut short partway through its directory', async () => {
    const doc = fixture('cv.doc')
    const directoryStart = (new DataView(doc.buffer).getUint32(48, true) + 1) * 512

    expect(await sniffType(new File([doc.subarray(0, directoryStart + 256)], 'cv.doc'), DOCUMENT_MATCHERS)).toBeNull()
  })

  it('refuses a Word 97-2003 file cut short in the second sector of its directory', async () => {
    const doc = fixture('cv.doc')

    expect(await sniffType(new File([doc.subarray(0, doc.length - 256)], 'cv.doc'), DOCUMENT_MATCHERS)).toBeNull()
  })

  it('never throws, and reads within the budget, whatever the bytes', async () => {
    const fixtures = [
      'cv.docx',
      'cv-data-descriptor.docx',
      'cv.doc',
      'cv-word6.doc',
      'book-with-document.xls',
      'cv.odt',
      'notes.txt'
    ].map(fixture)

    await fc.assert(
      fc.asyncProperty(documentLikeBytes(fixtures), async (bytes) => {
        const failures: unknown[] = []
        const watched = DOCUMENT_MATCHERS.map((matcher): FileMatcher => {
          const inspect = matcher.inspect
          return {
            ...matcher,
            test: (header) => {
              try {
                return matcher.test(header)
              } catch (error) {
                failures.push(error)
                return false
              }
            },
            inspect:
              inspect &&
              (async (reader) => {
                try {
                  return await inspect(reader)
                } catch (error) {
                  failures.push(error)
                  throw error
                }
              })
          }
        })

        await sniffType(new File([bytes], 'upload.bin'), watched)

        expect(failures).toEqual([])
      }),
      { numRuns: 300 }
    )
  })
})

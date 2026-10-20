import { readFileSync } from 'node:fs'
import {
  ALL_TYPES,
  DOCUMENT_TYPES,
  FILE_TYPES,
  IMAGE_TYPES,
  MEDIA_TYPES,
  sniffBytes,
  sniffType,
  TEXT_TYPES,
  VIDEO_TYPES,
  WORD_TYPES
} from '#index.js'
import { describe, expect, it } from 'vitest'

/** A fixture as the browser would hand it over. */
function fixtureFile(name: string): File {
  return new File([new Uint8Array(readFileSync(new URL(`../fixtures/files/${name}`, import.meta.url)))], name)
}

/** The byte values of an ASCII string, one per character. */
function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0))
}

/** The leading bytes of an ISO-BMFF file: an `ftyp` box naming `majorBrand` and `compatibleBrands`. */
function ftypHeader(majorBrand: string, compatibleBrands: string[] = []): Uint8Array<ArrayBuffer> {
  const size = 16 + compatibleBrands.length * 4
  return new Uint8Array([
    0,
    0,
    0,
    size,
    ...ascii('ftyp'),
    ...ascii(majorBrand),
    0,
    0,
    0,
    0,
    ...compatibleBrands.flatMap(ascii)
  ])
}

/** The leading bytes of an EBML file whose header declares `docType`. */
function ebmlHeader(docType: string): Uint8Array {
  const docTypeElement = [0x42, 0x82, 0x80 | docType.length, ...ascii(docType)]
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80 | docTypeElement.length, ...docTypeElement])
}

const QUICKTIME = 'video/quicktime'
const MP4 = 'video/mp4'
const THREE_GPP = 'video/3gpp'
const WEBM = 'video/webm'
const MATROSKA = 'video/x-matroska'

describe('FILE_TYPES', () => {
  it('names every built-in type once, ready to compose into an accept list', () => {
    expect(Object.keys(FILE_TYPES)).toEqual([
      'avif',
      'gif',
      'heic',
      'jpeg',
      'png',
      'webp',
      'pdf',
      'docx',
      'doc',
      'odt',
      'rtf',
      'text',
      'quicktime',
      'mp4',
      'threeGPP',
      'webm',
      'matroska'
    ])
    expect(Object.isFrozen(FILE_TYPES)).toBe(true)

    for (const [name, matcher] of Object.entries(FILE_TYPES)) {
      expect(matcher.contentType, name).toEqual(expect.any(String))
      expect(matcher.label, name).toEqual(expect.any(String))
      expect(matcher.extensions?.length, name).toBeGreaterThan(0)
    }
  })

  it('gives each type the content type, label and extensions it is saved under', () => {
    expect(
      Object.values(FILE_TYPES).map(({ contentType, label, extensions }) => [contentType, label, extensions])
    ).toEqual([
      ['image/avif', 'AVIF', ['avif']],
      ['image/gif', 'GIF', ['gif']],
      ['image/heic', 'HEIC', ['heic', 'heif']],
      ['image/jpeg', 'JPEG', ['jpg', 'jpeg', 'jpe', 'jfif']],
      ['image/png', 'PNG', ['png']],
      ['image/webp', 'WebP', ['webp']],
      ['application/pdf', 'PDF', ['pdf']],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word', ['docx']],
      ['application/msword', 'Word', ['doc']],
      ['application/vnd.oasis.opendocument.text', 'OpenDocument', ['odt']],
      ['application/rtf', 'RTF', ['rtf']],
      ['text/plain', 'Text', ['txt', 'md']],
      [QUICKTIME, 'QuickTime', ['mov']],
      [MP4, 'MP4', ['mp4', 'm4v']],
      [THREE_GPP, '3GP', ['3gp', '3g2']],
      [WEBM, 'WebM', ['webm']],
      [MATROSKA, 'Matroska', ['mkv']]
    ])
  })
})

describe('type groups', () => {
  it('are ready-made accept lists', () => {
    expect(IMAGE_TYPES).toEqual([
      FILE_TYPES.avif,
      FILE_TYPES.gif,
      FILE_TYPES.heic,
      FILE_TYPES.jpeg,
      FILE_TYPES.png,
      FILE_TYPES.webp
    ])
    expect(VIDEO_TYPES).toEqual([
      FILE_TYPES.quicktime,
      FILE_TYPES.mp4,
      FILE_TYPES.threeGPP,
      FILE_TYPES.webm,
      FILE_TYPES.matroska
    ])
    expect(MEDIA_TYPES).toEqual([...IMAGE_TYPES, ...VIDEO_TYPES])
    expect(WORD_TYPES).toEqual([FILE_TYPES.docx, FILE_TYPES.doc])
    expect(TEXT_TYPES).toEqual([FILE_TYPES.text])
    expect(DOCUMENT_TYPES).toEqual([
      FILE_TYPES.pdf,
      FILE_TYPES.docx,
      FILE_TYPES.doc,
      FILE_TYPES.odt,
      FILE_TYPES.rtf,
      FILE_TYPES.text
    ])
  })

  it('make ALL_TYPES every built-in type exactly once', () => {
    expect([...ALL_TYPES].sort((a, b) => a.contentType.localeCompare(b.contentType))).toEqual(
      Object.values(FILE_TYPES).sort((a, b) => a.contentType.localeCompare(b.contentType))
    )
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length)
  })

  it('check images before video, binary formats before RTF and plain text last', async () => {
    expect(await sniffType(fixtureFile('photo.heic'), ALL_TYPES)).toBe('image/heic')
    expect(await sniffType(fixtureFile('photo.avif'), ALL_TYPES)).toBe('image/avif')
    expect(await sniffType(fixtureFile('cv.rtf'), ALL_TYPES)).toBe('application/rtf')
    expect(await sniffType(fixtureFile('notes.txt'), ALL_TYPES)).toBe('text/plain')
    expect(await sniffType(fixtureFile('notes.md'), ALL_TYPES)).toBe('text/plain')

    for (const [name, contentType] of [
      ['clip.mov', QUICKTIME],
      ['legacy.mov', QUICKTIME],
      ['clip.mp4', MP4],
      ['clip.3gp', THREE_GPP],
      ['clip.webm', WEBM],
      ['clip.mkv', MATROSKA]
    ]) {
      expect(await sniffType(fixtureFile(name!), ALL_TYPES), name).toBe(contentType)
      expect(await sniffType(fixtureFile(name!), MEDIA_TYPES), name).toBe(contentType)
      expect(await sniffType(fixtureFile(name!), IMAGE_TYPES), name).toBeNull()
    }
  })

  it('resolve a header declaring an image brand and a video brand to the image', async () => {
    for (const [major, compatible, contentType] of [
      ['avif', 'isom', 'image/avif'],
      ['heic', 'mp42', 'image/heic']
    ] as const) {
      const file = new File([ftypHeader(major, [compatible])], 'upload.bin')
      expect(await sniffType(file, ALL_TYPES), major).toBe(contentType)
      expect(await sniffType(file, MEDIA_TYPES), major).toBe(contentType)
    }
  })

  it('keep an Office file, a macro-enabled document and a spreadsheet out of the types they resemble', async () => {
    for (const name of ['book.xlsx', 'slides.pptx', 'cv.docm', 'plain.zip', 'book.xls', 'slides.ppt']) {
      expect(await sniffType(fixtureFile(name), ALL_TYPES), name).toBeNull()
    }
  })
})

describe('video types', () => {
  it('recognise every MP4 brand, whether major or compatible', () => {
    for (const brand of [
      'isom',
      'iso2',
      'iso4',
      'iso5',
      'iso6',
      'mp41',
      'mp42',
      'avc1',
      'dash',
      'mmp4',
      'M4V ',
      'M4VH',
      'M4VP',
      'MSNV',
      'XAVC'
    ]) {
      expect(sniffBytes(ftypHeader(brand), VIDEO_TYPES), brand).toBe(MP4)
      expect(sniffBytes(ftypHeader('zzzz', ['zzzz', brand]), VIDEO_TYPES), brand).toBe(MP4)
    }
  })

  it('recognise a QuickTime brand and the legacy atoms a QuickTime file may open with', () => {
    expect(sniffBytes(ftypHeader('qt  ', ['qt  ']), VIDEO_TYPES)).toBe(QUICKTIME)

    for (const atom of ['moov', 'mdat', 'wide']) {
      expect(sniffBytes(new Uint8Array([0, 0, 0, 8, ...ascii(atom)]), VIDEO_TYPES), atom).toBe(QUICKTIME)
    }
  })

  it('take any 3GP brand as 3GP even when it also lists an MP4 brand', () => {
    for (const brand of ['3gp4', '3gp6', '3g2a']) {
      expect(sniffBytes(ftypHeader(brand, [brand, 'isom']), VIDEO_TYPES), brand).toBe(THREE_GPP)
    }
  })

  it('refuse an ISO-BMFF file that is neither video nor on the list', () => {
    expect(sniffBytes(ftypHeader('mif1', ['mif1']), VIDEO_TYPES)).toBeNull()
    expect(sniffBytes(ftypHeader('heic', ['mif1', 'heic']), VIDEO_TYPES)).toBeNull()
    expect(sniffBytes(ftypHeader('M4A ', ['M4A ', 'M4B ']), VIDEO_TYPES)).toBeNull()
  })

  it('tell WebM from Matroska by the document type in the EBML header', () => {
    expect(sniffBytes(ebmlHeader('webm'), VIDEO_TYPES)).toBe(WEBM)
    expect(sniffBytes(ebmlHeader('matroska'), VIDEO_TYPES)).toBe(MATROSKA)
    expect(sniffBytes(ebmlHeader('xmatroska'), VIDEO_TYPES)).toBeNull()
    expect(sniffBytes(ebmlHeader('divx'), VIDEO_TYPES)).toBeNull()
  })

  it('refuse an EBML signature without a readable document type', () => {
    expect(sniffBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), VIDEO_TYPES)).toBeNull()
    expect(sniffBytes(ebmlHeader('webm').subarray(0, 9), VIDEO_TYPES)).toBeNull()
    expect(sniffBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80]), VIDEO_TYPES)).toBeNull()
  })

  it('do not mistake text for a legacy QuickTime atom', async () => {
    for (const text of [
      'The wide road runs north.\n',
      'Some moov notes about the film.\n',
      'Data mdat for the report.\n'
    ]) {
      const file = new File([text], 'notes.txt')
      expect(await sniffType(file, ALL_TYPES), text).toBe('text/plain')
      expect(sniffBytes(new TextEncoder().encode(text), VIDEO_TYPES), text).toBeNull()
    }

    expect(sniffBytes(new Uint8Array([0, 0, 0, 7, ...ascii('wide')]), VIDEO_TYPES)).toBeNull()
  })

  it('never throw on a header too short to hold their signatures', () => {
    for (const length of [0, 1, 4, 7, 8, 11, 12, 15]) {
      expect(sniffBytes(ftypHeader('isom', ['isom']).subarray(0, length), VIDEO_TYPES)).toBeNull()
    }
  })
})

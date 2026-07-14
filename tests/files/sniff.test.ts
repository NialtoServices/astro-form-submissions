import { ALL_TYPES, DOCUMENT_TYPES, IMAGE_TYPES, sniffType } from '#files/sniff.js'
import { describe, expect, it } from 'vitest'

/** A File whose leading bytes are exactly `bytes` (nothing padded), so short-header handling is exercised for real. */
function fileWithHeader(bytes: number[]): File {
  return new File([new Uint8Array(bytes)], 'upload.bin')
}

/** The byte values of an ASCII string, one per character. */
function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0))
}

/**
 * A well-formed ISO-BMFF `ftyp` box: size, `ftyp`, the major brand, a zero minor version, then any compatible brands.
 * The declared box size matches the bytes produced, so it models a real file rather than a truncated one.
 */
function ftypHeader(majorBrand: string, compatibleBrands: string[] = []): number[] {
  const size = 16 + compatibleBrands.length * 4
  return [
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...ascii('ftyp'),
    ...ascii(majorBrand),
    0,
    0,
    0,
    0,
    ...compatibleBrands.flatMap(ascii)
  ]
}

const HEADERS = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  gif87a: ascii('GIF87a'),
  gif89a: ascii('GIF89a'),
  webp: [...ascii('RIFF'), 0x00, 0x00, 0x00, 0x00, ...ascii('WEBP')],
  pdf: ascii('%PDF-')
}

describe('sniffType', () => {
  describe('the default allow-list', () => {
    it('identifies each image type from its magic bytes', async () => {
      expect(await sniffType(fileWithHeader(HEADERS.jpeg))).toBe('image/jpeg')
      expect(await sniffType(fileWithHeader(HEADERS.png))).toBe('image/png')
      expect(await sniffType(fileWithHeader(HEADERS.gif87a))).toBe('image/gif')
      expect(await sniffType(fileWithHeader(HEADERS.gif89a))).toBe('image/gif')
      expect(await sniffType(fileWithHeader(HEADERS.webp))).toBe('image/webp')
    })

    it('identifies PDF from its header', async () => {
      expect(await sniffType(fileWithHeader(HEADERS.pdf))).toBe('application/pdf')
    })

    it('returns null for bytes matching nothing on the list', async () => {
      expect(await sniffType(fileWithHeader([0x00, 0x01, 0x02, 0x03]))).toBeNull()
    })
  })

  describe('restricting the allow-list', () => {
    it('rejects a type absent from the restricted list', async () => {
      expect(await sniffType(fileWithHeader(HEADERS.png), DOCUMENT_TYPES)).toBeNull()
    })

    it('accepts a type present on the restricted list', async () => {
      expect(await sniffType(fileWithHeader(HEADERS.pdf), DOCUMENT_TYPES)).toBe('application/pdf')
    })
  })

  describe('ISO-BMFF brand detection', () => {
    it('accepts AVIF declared in the major brand', async () => {
      expect(await sniffType(fileWithHeader(ftypHeader('avif')))).toBe('image/avif')
      expect(await sniffType(fileWithHeader(ftypHeader('avis')))).toBe('image/avif')
    })

    it('accepts AVIF declared only as a compatible brand', async () => {
      expect(await sniffType(fileWithHeader(ftypHeader('mif1', ['avif'])))).toBe('image/avif')
    })

    it('accepts each registered HEIC brand', async () => {
      for (const brand of ['heic', 'heix', 'heim', 'heis']) {
        expect(await sniffType(fileWithHeader(ftypHeader(brand)))).toBe('image/heic')
      }
    })

    it('accepts a HEIC brand carried in the compatible list', async () => {
      expect(await sniffType(fileWithHeader(ftypHeader('mif1', ['heic'])))).toBe('image/heic')
    })

    it('takes AVIF over HEIC when a file declares both', async () => {
      expect(await sniffType(fileWithHeader(ftypHeader('mif1', ['avif', 'heic'])))).toBe('image/avif')
    })

    it('files a structural-only HEIF (mif1) as neither AVIF nor HEIC', async () => {
      expect(await sniffType(fileWithHeader(ftypHeader('mif1')))).toBeNull()
    })

    it('rejects sequence and non-image brands (hevc, msf1, plain mp4)', async () => {
      expect(await sniffType(fileWithHeader(ftypHeader('hevc')))).toBeNull()
      expect(await sniffType(fileWithHeader(ftypHeader('msf1')))).toBeNull()
      expect(await sniffType(fileWithHeader(ftypHeader('mp42')))).toBeNull()
    })

    it('declines an ftyp box whose declared size is too small to hold a brand', async () => {
      const undersized = [0x00, 0x00, 0x00, 0x08, ...ascii('ftyp'), ...ascii('heic')]
      expect(await sniffType(fileWithHeader(undersized))).toBeNull()
    })

    it('declines a physically truncated ftyp box that ends right after the major brand (COR-002)', async () => {
      // Declares a 16-byte box but only 12 bytes exist (no minor version) — a truncated container.
      const truncatedAvif = [0x00, 0x00, 0x00, 0x10, ...ascii('ftyp'), ...ascii('avif')]
      const truncatedHeic = [0x00, 0x00, 0x00, 0x10, ...ascii('ftyp'), ...ascii('heic')]
      expect(truncatedAvif).toHaveLength(12)
      expect(await sniffType(fileWithHeader(truncatedAvif))).toBeNull()
      expect(await sniffType(fileWithHeader(truncatedHeic))).toBeNull()
    })
  })

  describe('short or malformed headers', () => {
    it('returns null without throwing for a truncated header', async () => {
      expect(await sniffType(fileWithHeader([0xff]))).toBeNull()
      expect(await sniffType(fileWithHeader([]))).toBeNull()
    })

    it('requires the marker byte after the JPEG SOI', async () => {
      expect(await sniffType(fileWithHeader([0xff, 0xd8]))).toBeNull()
      expect(await sniffType(fileWithHeader([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
    })

    it('requires the full GIF version signature, not just GIF8', async () => {
      expect(await sniffType(fileWithHeader(ascii('GIF8')))).toBeNull()
    })
  })

  it('exposes PDF through the document allow-list and images through the image allow-list', async () => {
    expect(await sniffType(fileWithHeader(HEADERS.pdf), IMAGE_TYPES)).toBeNull()
    expect(await sniffType(fileWithHeader(HEADERS.jpeg), ALL_TYPES)).toBe('image/jpeg')
  })
})

import { MAX_INSPECTED_BYTES, MAX_INSPECTED_READS, type ByteRangeReader } from '#files/byte-range-reader.js'
import { ALL_TYPES, DOCUMENT_TYPES, HEADER_BYTES, IMAGE_TYPES, sniffType, type FileMatcher } from '#files/sniff.js'
import fc from 'fast-check'
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

    it('declines a physically truncated ftyp box that ends right after the major brand', async () => {
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

  it('names the extensions every built-in type is saved under', () => {
    expect(ALL_TYPES.filter((matcher) => !matcher.extensions?.length)).toEqual([])
  })
})

/** Whether two byte arrays hold the same bytes; a plain loop, as `toEqual` crawls over arrays of this size. */
function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
}

/** A matcher whose header test always passes, so that `inspect` alone decides. */
function inspecting(inspect: FileMatcher['inspect']): FileMatcher {
  return { contentType: 'application/x-inspected', test: () => true, inspect }
}

/** A File that records every range sliced from it, as the bytes the slice covers. */
class RecordingFile extends File {
  readonly sliced: number[] = []

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const slice = super.slice(start, end, contentType)
    this.sliced.push(slice.size)
    return slice
  }
}

describe('sniffType with ranged reads', () => {
  it('grants a type when the header test passes and inspect resolves true', async () => {
    const file = new File([new Uint8Array(100).fill(7)], 'upload.bin')

    expect(await sniffType(file, [inspecting(async (reader) => reader.size === 100)])).toBe('application/x-inspected')
    expect(await sniffType(file, [inspecting(async () => false)])).toBeNull()
  })

  it('never runs inspect for a file the header test refuses', async () => {
    let inspected = false
    const matcher: FileMatcher = {
      contentType: 'application/x-inspected',
      test: () => false,
      inspect: async () => (inspected = true)
    }

    expect(await sniffType(new File([new Uint8Array(100)], 'upload.bin'), [matcher])).toBeNull()
    expect(inspected).toBe(false)
  })

  it('treats a matcher that throws or rejects as no match, and moves on to the next', async () => {
    const file = new File([new Uint8Array(100)], 'upload.bin')
    const fallback = { ...inspecting(async () => true), contentType: 'application/x-fallback' }

    const rejecting = inspecting(async () => Promise.reject(new Error('boom')))
    const throwing = inspecting(() => {
      throw new Error('boom')
    })
    const throwingHeaderTest: FileMatcher = {
      contentType: 'application/x-broken',
      test: () => {
        throw new Error('boom')
      }
    }

    expect(await sniffType(file, [rejecting, throwing, throwingHeaderTest, fallback])).toBe('application/x-fallback')
  })

  it('reads the slice asked for, and what exists when the range runs past the end', async () => {
    const file = new File([Uint8Array.from({ length: 10 }, (_value, index) => index)], 'upload.bin')
    const seen: number[][] = []

    await sniffType(file, [
      inspecting(async (reader) => {
        seen.push([...(await reader.read(2, 3))], [...(await reader.read(8, 50))], [...(await reader.read(40, 4))])
        return false
      })
    ])

    expect(seen).toEqual([[2, 3, 4], [8, 9], []])
  })

  it('refuses a read that would take the file past its byte budget', async () => {
    const file = new File([new Uint8Array(MAX_INSPECTED_BYTES * 2)], 'upload.bin')
    const outcomes: string[] = []

    await sniffType(file, [
      inspecting(async (reader) => {
        await reader.read(0, MAX_INSPECTED_BYTES - 10)
        outcomes.push(
          await reader.read(0, 20).then(
            () => 'read',
            () => 'refused'
          )
        )
        outcomes.push(
          await reader.read(0, 10).then(
            () => 'read',
            () => 'refused'
          )
        )
        return false
      })
    ])

    expect(outcomes).toEqual(['refused', 'read'])
  })

  it('refuses a read beyond the read budget, however small', async () => {
    const file = new File([new Uint8Array(1000)], 'upload.bin')
    const outcomes: string[] = []

    await sniffType(file, [
      inspecting(async (reader) => {
        for (let attempt = 0; attempt <= MAX_INSPECTED_READS; attempt++) {
          outcomes.push(
            await reader.read(0, 1).then(
              () => 'read',
              () => 'refused'
            )
          )
        }
        return false
      })
    ])

    expect(outcomes).toEqual([...Array<string>(MAX_INSPECTED_READS).fill('read'), 'refused'])
  })

  it('shares one budget across every matcher inspecting the same file', async () => {
    const file = new File([new Uint8Array(1000)], 'upload.bin')
    const outcomes: string[] = []
    const greedy = inspecting(async (reader) => {
      for (let attempt = 0; attempt < MAX_INSPECTED_READS; attempt++) await reader.read(0, 1)
      return false
    })
    const next = inspecting(async (reader) => {
      outcomes.push(
        await reader.read(0, 1).then(
          () => 'read',
          () => 'refused'
        )
      )
      return false
    })

    await sniffType(file, [greedy, next])

    expect(outcomes).toEqual(['refused'])
  })

  it('refuses a read with a negative or fractional range', async () => {
    const file = new File([new Uint8Array(100)], 'upload.bin')
    const outcomes: string[] = []

    await sniffType(file, [
      inspecting(async (reader) => {
        for (const [offset, length] of [
          [-1, 4],
          [0, -4],
          [0.5, 4],
          [0, Number.NaN]
        ] as const) {
          outcomes.push(
            await reader.read(offset, length).then(
              () => 'read',
              () => 'refused'
            )
          )
        }
        return false
      })
    ])

    expect(outcomes).toEqual(['refused', 'refused', 'refused', 'refused'])
  })

  it('never throws and never reads more than the budget, whatever the bytes and the ranges asked for', async () => {
    const reads = fc.array(fc.tuple(fc.integer({ min: -8, max: 200_000 }), fc.integer({ min: -8, max: 100_000 })), {
      maxLength: 12
    })
    const contents = fc.oneof(
      { weight: 3, arbitrary: fc.uint8Array({ maxLength: 300 }) },

      // Only the length matters past the budget, and a patterned body shrinks to its size alone, where an arbitrary
      // one this long makes a failing run take minutes to shrink.
      {
        weight: 1,
        arbitrary: fc
          .integer({ min: 70_000, max: 150_000 })
          .map((length) => Uint8Array.from({ length }, (_value, index) => (index * 31) % 251))
      }
    )

    await fc.assert(
      fc.asyncProperty(contents, reads, async (bytes, plan) => {
        const file = new RecordingFile([bytes], 'upload.bin')
        let totalRead = 0
        let readCount = 0
        const matcher = inspecting(async (reader: ByteRangeReader) => {
          for (const [offset, length] of plan) {
            const slice = await reader.read(offset, length).catch(() => undefined)
            if (!slice) continue

            readCount++
            totalRead += slice.length
            expect(sameBytes(slice, bytes.subarray(offset, offset + length))).toBe(true)
          }
          return true
        })

        await expect(sniffType(file, [matcher])).resolves.toBeTypeOf('string')

        expect(totalRead).toBeLessThanOrEqual(MAX_INSPECTED_BYTES)
        expect(readCount).toBeLessThanOrEqual(MAX_INSPECTED_READS)

        // The header read comes first; every slice after it is a ranged read, and the file itself is the other witness.
        const [headerSlice = 0, ...rangedSlices] = file.sliced
        expect(headerSlice).toBeLessThanOrEqual(HEADER_BYTES)
        expect(rangedSlices.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(MAX_INSPECTED_BYTES)
      }),
      { numRuns: 60 }
    )
  })
})

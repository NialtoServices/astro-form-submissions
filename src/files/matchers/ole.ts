// Compound File Binary ("OLE") documents, the container Word, Excel and PowerPoint 97–2003 share. What tells
// them apart is the streams the container holds, which its directory lists by name.

import type { ByteRangeReader } from '#files/byte-range-reader.js'
import { dataView, hasSignature } from '#files/matchers/bytes.js'
import type { FileMatcher } from '#files/sniff.js'

const COMPOUND_FILE_SIGNATURE = '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'

/** The header fields the header test reads end with the directory's first sector number, at offsets 48–51. */
const HEADER_FIELDS_BYTES = 52

/** The whole header, whose last 436 bytes list the first FAT sectors (its DIFAT array). */
const HEADER_BYTES = 512

/** Where the header's DIFAT array starts, and how many FAT sector numbers it holds. */
const HEADER_DIFAT_OFFSET = 76
const HEADER_DIFAT_ENTRIES = 109

/** Each directory entry's size, whatever the sector size. */
const DIRECTORY_ENTRY_BYTES = 128

/**
 * The highest number of a sector that holds data (MS-CFB's `MAXREGSECT`). The values above it are reserved, or
 * mark DIFAT, FAT, end-of-chain and free sectors.
 */
const MAX_REGULAR_SECTOR = 0xfffffffa

const ROOT_STORAGE_TYPE = 5
const STREAM_TYPE = 2

/** The main streams of an Excel or PowerPoint 97–2003 file, which a Word document never holds as its own. */
const OTHER_APPLICATION_STREAMS = ['Workbook', 'Book', 'PowerPoint Document']

/**
 * Reads a compound file header's sector size, holding it to the two the format defines: 512-byte sectors for
 * version 3 and 4,096-byte sectors for version 4.
 *
 * @param bytes - The file's leading bytes.
 * @returns The sector size's power of two, or `null` when the bytes aren't a compound file header it can read.
 */
function sectorShift(bytes: Uint8Array): number | null {
  if (bytes.length < HEADER_FIELDS_BYTES || !hasSignature(bytes, COMPOUND_FILE_SIGNATURE)) return null

  const view = dataView(bytes)
  const majorVersion = view.getUint16(26, true)
  const byteOrder = view.getUint16(28, true)
  const shift = view.getUint16(30, true)
  if (byteOrder !== 0xfffe) return null
  if (majorVersion === 3 && shift === 9) return shift
  if (majorVersion === 4 && shift === 12) return shift

  return null
}

/**
 * Tests a directory entry's name against `expected`, as the UTF-16LE string with its terminator that the
 * format stores, for names in the ASCII range.
 *
 * @param entry - The directory entry's bytes.
 * @param expected - The name to look for.
 */
function entryNameIs(entry: Uint8Array, expected: string): boolean {
  const view = dataView(entry)
  if (view.getUint16(64, true) !== (expected.length + 1) * 2) return false

  for (let index = 0; index < expected.length; index++) {
    if (view.getUint16(index * 2, true) !== expected.charCodeAt(index)) return false
  }

  return view.getUint16(expected.length * 2, true) === 0
}

/**
 * Reads one sector of a compound file.
 *
 * @param reader - Reads ranges of the file.
 * @param sector - The sector's number.
 * @param sectorSize - The file's sector size.
 * @returns The sector's bytes, or `null` when the number marks no data sector or the file ends before the
 *   sector does.
 */
async function readSector(reader: ByteRangeReader, sector: number, sectorSize: number): Promise<Uint8Array | null> {
  if (sector > MAX_REGULAR_SECTOR) return null

  // Sector n starts after the header, which occupies the first sector's worth of bytes.
  const bytes = await reader.read((sector + 1) * sectorSize, sectorSize)
  return bytes.length === sectorSize ? bytes : null
}

/**
 * Reads the directory's first two sectors: the one the header points to, then the one the FAT chains it to.
 *
 * @param reader - Reads ranges of the file.
 * @param header - The file's whole header.
 * @param sectorSize - The file's sector size.
 * @returns The sectors, just the first when the chain ends there or its FAT sector isn't among those the
 *   header lists, or `null` when the file ends before a sector the chain names.
 */
async function firstDirectorySectors(
  reader: ByteRangeReader,
  header: Uint8Array,
  sectorSize: number
): Promise<Uint8Array[] | null> {
  const firstSector = dataView(header).getUint32(48, true)
  const first = await readSector(reader, firstSector, sectorSize)
  if (!first) return null

  const entriesPerSector = sectorSize / 4
  const difatIndex = Math.floor(firstSector / entriesPerSector)
  if (difatIndex >= HEADER_DIFAT_ENTRIES) return [first]

  const fat = await readSector(
    reader,
    dataView(header).getUint32(HEADER_DIFAT_OFFSET + difatIndex * 4, true),
    sectorSize
  )
  if (!fat) return null

  const secondSector = dataView(fat).getUint32((firstSector % entriesPerSector) * 4, true)
  if (secondSector > MAX_REGULAR_SECTOR || secondSector === firstSector) return [first]

  const second = await readSector(reader, secondSector, sectorSize)
  return second ? [first, second] : null
}

/**
 * Word 97–2003 (`.doc`): a compound file whose first two directory sectors, following the header's pointer and
 * the FAT's chain, list a `WordDocument` stream and no `Workbook`, `Book` or `PowerPoint Document` stream, so
 * an Excel or PowerPoint file embedding a Word document isn't taken for one. A `WordDocument` stream listed in
 * a later directory sector isn't seen, and the file is refused.
 */
export const DOC_TYPE: FileMatcher = {
  contentType: 'application/msword',
  extensions: ['doc'],
  label: 'Word',
  test: (bytes) => sectorShift(bytes) !== null,
  inspect: async (reader) => {
    const header = await reader.read(0, HEADER_BYTES)
    const shift = sectorShift(header)
    if (shift === null || header.length !== HEADER_BYTES) return false

    const sectorSize = 2 ** shift
    const directory = await firstDirectorySectors(reader, header, sectorSize)

    // The first directory sector always begins with the root storage's entry.
    if (!directory || directory[0]?.[66] !== ROOT_STORAGE_TYPE) return false

    let listsWordDocument = false
    for (const sector of directory) {
      for (let offset = 0; offset < sectorSize; offset += DIRECTORY_ENTRY_BYTES) {
        const entry = sector.subarray(offset, offset + DIRECTORY_ENTRY_BYTES)
        if (entry[66] !== STREAM_TYPE) continue
        if (OTHER_APPLICATION_STREAMS.some((name) => entryNameIs(entry, name))) return false
        if (entryNameIs(entry, 'WordDocument')) listsWordDocument = true
      }
    }

    return listsWordDocument
  }
}

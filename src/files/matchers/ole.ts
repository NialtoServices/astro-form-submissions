// Compound File Binary ("OLE") documents, the container Word, Excel and PowerPoint 97–2003 share. What tells
// them apart is the streams the container holds, which its directory lists by name.

import { dataView, hasSignature } from '#files/matchers/bytes.js'
import type { FileMatcher } from '#files/sniff.js'

const COMPOUND_FILE_SIGNATURE = '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'

/** The header fields read here end with the directory's first sector number, at offsets 48–51. */
const HEADER_FIELDS_BYTES = 52

/** Each directory entry's size, whatever the sector size. */
const DIRECTORY_ENTRY_BYTES = 128

/** Sector numbers from this value up mark free, end-of-chain or allocation-table sectors, never data. */
const MAX_REGULAR_SECTOR = 0xfffffff9

const ROOT_STORAGE_TYPE = 5
const STREAM_TYPE = 2

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
 * Word 97–2003 (`.doc`): a compound file whose first directory sector, which the header points to, lists a
 * `WordDocument` stream. A stream listed in a later directory sector isn't seen, and the file is refused.
 */
export const DOC_TYPE: FileMatcher = {
  contentType: 'application/msword',
  extensions: ['doc'],
  label: 'Word',
  test: (bytes) => sectorShift(bytes) !== null,
  inspect: async (reader) => {
    const header = await reader.read(0, HEADER_FIELDS_BYTES)
    const shift = sectorShift(header)
    if (shift === null) return false

    const directorySector = dataView(header).getUint32(48, true)
    if (directorySector > MAX_REGULAR_SECTOR) return false

    // Sector n starts after the header, which occupies the first sector's worth of bytes.
    const sectorSize = 2 ** shift
    const directory = await reader.read((directorySector + 1) * sectorSize, sectorSize)
    if (directory.length !== sectorSize) return false

    // The first directory sector always begins with the root storage's entry.
    if (directory[66] !== ROOT_STORAGE_TYPE) return false

    for (let offset = DIRECTORY_ENTRY_BYTES; offset < sectorSize; offset += DIRECTORY_ENTRY_BYTES) {
      const entry = directory.subarray(offset, offset + DIRECTORY_ENTRY_BYTES)
      if (entry[66] === STREAM_TYPE && entryNameIs(entry, 'WordDocument')) return true
    }

    return false
  }
}

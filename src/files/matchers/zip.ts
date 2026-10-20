// ZIP-based document formats, recognised from the archive's structure alone: entry names from the central
// directory, and the one entry an OpenDocument package stores uncompressed at the very start. Nothing is
// ever inflated, so no entry's content is read beyond that stored one.

import type { ByteRangeReader } from '#files/byte-range-reader.js'
import { dataView, hasSignature } from '#files/matchers/bytes.js'
import type { FileMatcher } from '#files/sniff.js'

const LOCAL_FILE_HEADER_SIGNATURE = 'PK\x03\x04'
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 'PK\x01\x02'
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 'PK\x05\x06'

/** The fixed part of a local file header, before its name and extra field. */
const LOCAL_FILE_HEADER_BYTES = 30

/** The fixed part of a central directory entry, before its name, extra field and comment. */
const CENTRAL_DIRECTORY_ENTRY_BYTES = 46

/** The end-of-central-directory record without its trailing comment. */
const END_OF_CENTRAL_DIRECTORY_BYTES = 22

/**
 * How much of the end of an archive is read first, looking for its end-of-central-directory record. The central
 * directory sits immediately before that record, so for most archives this one read holds both.
 */
const ARCHIVE_TAIL_BYTES = 32 * 1024

/**
 * The most an archive's index (central directory, end record and comment) may take in all. It leaves the rest of
 * `MAX_INSPECTED_BYTES` for the matchers tried after this one, such as {@link ODT_TYPE} on the same archive.
 */
const MAX_ARCHIVE_INDEX_BYTES = 48 * 1024

/** The value a ZIP64 archive puts in a field too small for it, whose real value lies in a record we don't read. */
const ZIP64_COUNT = 0xffff
const ZIP64_SIZE = 0xffffffff

/** Where an archive's end record lies, and the central directory it locates. */
interface EndOfCentralDirectory {
  /** The record's offset within the bytes it was found in. */
  recordOffset: number

  /** How many entries the directory holds. */
  entryCount: number

  /** The directory's offset from the start of the archive. */
  directoryOffset: number

  /** The directory's size in bytes. */
  directorySize: number
}

/**
 * Finds the end-of-central-directory record in an archive's tail: the last signature whose comment, as its own
 * length field declares it, runs exactly to the end of the file.
 *
 * @param tail - The archive's last bytes, ending at the end of the file.
 * @returns The record's offset within `tail` and the directory it locates, or `null` when there is none, the
 *   archive spans several disks, or it needs ZIP64 records.
 */
function findEndOfCentralDirectory(tail: Uint8Array): EndOfCentralDirectory | null {
  const view = dataView(tail)

  for (let offset = tail.length - END_OF_CENTRAL_DIRECTORY_BYTES; offset >= 0; offset--) {
    if (!hasSignature(tail, END_OF_CENTRAL_DIRECTORY_SIGNATURE, offset)) continue
    if (view.getUint16(offset + 20, true) !== tail.length - offset - END_OF_CENTRAL_DIRECTORY_BYTES) continue

    const diskNumber = view.getUint16(offset + 4, true)
    const directoryDisk = view.getUint16(offset + 6, true)
    const entriesOnDisk = view.getUint16(offset + 8, true)
    const entryCount = view.getUint16(offset + 10, true)
    const directorySize = view.getUint32(offset + 12, true)
    const directoryOffset = view.getUint32(offset + 16, true)
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) return null
    if (entryCount === ZIP64_COUNT || directorySize === ZIP64_SIZE || directoryOffset === ZIP64_SIZE) return null

    return { recordOffset: offset, entryCount, directoryOffset, directorySize }
  }

  return null
}

/**
 * Reads the name of every entry an archive's central directory lists, without touching any entry's data.
 *
 * Fails closed on anything it can't vouch for: no end record in the tail, a directory that doesn't end where
 * the record begins, an index larger than {@link MAX_ARCHIVE_INDEX_BYTES}, or entries that don't fill the
 * directory exactly.
 *
 * @param reader - Reads ranges of the archive.
 * @returns Each entry's name as raw bytes, in directory order, or `null` when the directory can't be read.
 */
async function centralDirectoryNames(reader: ByteRangeReader): Promise<Uint8Array[] | null> {
  if (reader.size < END_OF_CENTRAL_DIRECTORY_BYTES) return null

  const tailStart = Math.max(0, reader.size - ARCHIVE_TAIL_BYTES)
  const tail = await reader.read(tailStart, reader.size - tailStart)
  if (tail.length !== reader.size - tailStart) return null

  const endRecord = findEndOfCentralDirectory(tail)
  if (!endRecord) return null

  const { recordOffset, entryCount, directoryOffset, directorySize } = endRecord
  if (directoryOffset + directorySize !== tailStart + recordOffset) return null

  let directory: Uint8Array
  if (directoryOffset >= tailStart) {
    directory = tail.subarray(directoryOffset - tailStart, recordOffset)
  } else {
    const missing = tailStart - directoryOffset
    if (missing + tail.length > MAX_ARCHIVE_INDEX_BYTES) return null

    const head = await reader.read(directoryOffset, missing)
    if (head.length !== missing) return null

    directory = new Uint8Array(directorySize)
    directory.set(head)
    directory.set(tail.subarray(0, recordOffset), missing)
  }

  return entryNames(directory, entryCount)
}

/**
 * Walks a central directory's entries.
 *
 * @param directory - Exactly the directory's bytes.
 * @param entryCount - How many entries the end record says it holds.
 * @returns Each entry's name, or `null` when the entries don't match the count or fill the directory exactly.
 */
function entryNames(directory: Uint8Array, entryCount: number): Uint8Array[] | null {
  const view = dataView(directory)
  const names: Uint8Array[] = []

  let offset = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + CENTRAL_DIRECTORY_ENTRY_BYTES > directory.length) return null
    if (!hasSignature(directory, CENTRAL_DIRECTORY_ENTRY_SIGNATURE, offset)) return null

    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nameStart = offset + CENTRAL_DIRECTORY_ENTRY_BYTES
    const next = nameStart + nameLength + extraLength + commentLength
    if (next > directory.length) return null

    names.push(directory.subarray(nameStart, nameStart + nameLength))
    offset = next
  }

  return offset === directory.length ? names : null
}

/**
 * Tests an entry name against an ASCII name, ignoring ASCII case as package part names do.
 *
 * @param name - The entry's name, as raw bytes.
 * @param expected - The name to compare against, in lower case.
 */
function nameIs(name: Uint8Array, expected: string): boolean {
  if (name.length !== expected.length) return false

  for (let index = 0; index < expected.length; index++) {
    const byte = name[index] ?? 0
    const lowered = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
    if (lowered !== expected.charCodeAt(index)) return false
  }

  return true
}

/** The name Word stores a document's macro project under, in lower case. */
const MACRO_PROJECT_NAME = 'vbaproject.bin'

/**
 * Tests whether an entry is a macro project, in whichever folder it sits.
 *
 * @param name - The entry's name, as raw bytes.
 */
function isMacroProject(name: Uint8Array): boolean {
  if (nameIs(name, MACRO_PROJECT_NAME)) return true

  const suffix = `/${MACRO_PROJECT_NAME}`
  return name.length > suffix.length && nameIs(name.subarray(name.length - suffix.length), suffix)
}

/**
 * Tests whether an archive's first entry is a stored, uncompressed `mimetype` whose content is exactly
 * `mimetype`, the way every OpenDocument package must begin.
 *
 * @param bytes - The archive's leading bytes. With fewer than the whole entry, only what is present is compared,
 *   so the header test can rule a file out early.
 * @param mimetype - The media type the package must declare.
 * @param complete - Whether `bytes` must hold the whole entry, for a final answer.
 */
function startsWithMimetype(bytes: Uint8Array, mimetype: string, complete: boolean): boolean {
  const contentStart = LOCAL_FILE_HEADER_BYTES + 'mimetype'.length
  if (bytes.length < contentStart) return false
  if (complete && bytes.length < contentStart + mimetype.length) return false
  if (!hasSignature(bytes, LOCAL_FILE_HEADER_SIGNATURE) || !hasSignature(bytes, 'mimetype', LOCAL_FILE_HEADER_BYTES)) {
    return false
  }

  const view = dataView(bytes)
  const encrypted = (view.getUint16(6, true) & 0x0001) !== 0
  const compression = view.getUint16(8, true)
  const compressedSize = view.getUint32(18, true)
  const size = view.getUint32(22, true)
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  if (encrypted || compression !== 0 || nameLength !== 'mimetype'.length || extraLength !== 0) return false

  // The declared sizes tell `application/vnd.oasis.opendocument.text` from the template and master-document
  // types it is a prefix of.
  if (compressedSize !== mimetype.length || size !== mimetype.length) return false

  const present = Math.min(mimetype.length, bytes.length - contentStart)
  return hasSignature(bytes, mimetype.slice(0, present), contentStart)
}

/** Word (`.docx`): a ZIP whose central directory lists the main document part and no macro project. */
export const DOCX_TYPE: FileMatcher = {
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extensions: ['docx'],
  label: 'Word',
  test: (bytes) => hasSignature(bytes, LOCAL_FILE_HEADER_SIGNATURE),
  inspect: async (reader) => {
    const names = await centralDirectoryNames(reader)
    if (!names) return false

    // Word stores a macro project as `word/vbaProject.bin`; refusing the name in any folder also covers a package
    // whose relationships point at it elsewhere.
    return names.some((name) => nameIs(name, 'word/document.xml')) && !names.some(isMacroProject)
  }
}

/** The media type an OpenDocument text package declares in its `mimetype` entry. */
const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text'

/** OpenDocument text (`.odt`): a ZIP whose first entry is a stored `mimetype` naming the text type. */
export const ODT_TYPE: FileMatcher = {
  contentType: ODT_MIMETYPE,
  extensions: ['odt'],
  label: 'OpenDocument',
  test: (bytes) => startsWithMimetype(bytes, ODT_MIMETYPE, false),
  inspect: async (reader) => {
    const length = LOCAL_FILE_HEADER_BYTES + 'mimetype'.length + ODT_MIMETYPE.length
    return startsWithMimetype(await reader.read(0, length), ODT_MIMETYPE, true)
  }
}

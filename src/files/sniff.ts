// Magic-byte sniffing for the upload allow-list. The client-supplied MIME type is never trusted (a file can be renamed).
// On the multipart path the content-type returned here is stored on the object and echoed back by the download route; on
// the direct path it is compared with the type the object was stored with. Returns null for anything off the allow-list.
//
// A passing matcher means "the leading bytes are well-formed for this type", not "this file is safe": the download route
// still needs `X-Content-Type-Options: nosniff`, and inline PDFs on the app origin need `Content-Disposition: attachment`
// (or a separate, cookieless origin).

import { ByteRangeReadError } from '#files/byte-range-read-error.js'
import { readerForFile, type ByteRangeReader } from '#files/byte-range-reader.js'
import { hasSignature } from '#files/matchers/bytes.js'
import { ftypBrands, ftypBrandsIncludeAny } from '#files/matchers/ftyp.js'
import { DOC_TYPE } from '#files/matchers/ole.js'
import { RTF_TYPE } from '#files/matchers/rtf.js'
import { TEXT_TYPE } from '#files/matchers/text.js'
import { MATROSKA_TYPE, MP4_TYPE, QUICKTIME_TYPE, THREE_GPP_TYPE, WEBM_TYPE } from '#files/matchers/video.js'
import { DOCX_TYPE, ODT_TYPE } from '#files/matchers/zip.js'

/**
 * Number of leading bytes read and handed to each matcher.
 *
 * 64 covers ISO-BMFF `ftyp` boxes, whose variable-length list of compatible brands typically runs 24–32 bytes. Every
 * other signature here fits in the first 12.
 */
export const HEADER_BYTES = 64

/** A single content-type matcher: the type it grants and a header-bytes test. */
export interface FileMatcher {
  /** The content-type this matcher grants when its test passes. */
  contentType: string

  /** A short, readable name for the type (`PDF`, `Word`), for hint text. Optional. */
  label?: string

  /**
   * The extensions a file of this type is saved under, without the dot, most common first; case doesn't
   * matter. A stored name that doesn't end in one of them gets the first appended, so the saved file opens
   * as the type its bytes were checked against. Omit it to keep names as given.
   */
  extensions?: readonly string[]

  /**
   * Tests the file's leading bytes; `true` accepts the file as {@link FileMatcher.contentType}.
   *
   * The array holds at most {@link HEADER_BYTES} bytes and may be **shorter**, so no index can be assumed present.
   * Reading past the end gives `undefined`, which fails every `===` comparison; anything doing arithmetic or slicing
   * needs an explicit length check. A matcher must never throw.
   */
  test: (bytes: Uint8Array) => boolean

  /**
   * Confirms the type from bytes beyond the header, by reading ranges of the file. Optional: a matcher without
   * it decides from {@link FileMatcher.test} alone.
   *
   * The matcher grants its type when `test` passes **and** `inspect` resolves `true`; `inspect` only runs once
   * `test` has passed. The reader enforces a budget per file ({@link MAX_INSPECTED_BYTES} bytes and
   * {@link MAX_INSPECTED_READS} reads, shared by every matcher tried against the file), rejecting a read past
   * it. A throw or rejection counts as no match, as does a storage that can't read ranges, so structure outside
   * the ranges a matcher reads is never assumed. The one exception is a read the storage itself fails, which says
   * nothing about the file's type: its rejection propagates out of the type check, so a matcher should let it.
   */
  inspect?: (reader: ByteRangeReader) => Promise<boolean>
}

const AVIF_TYPE: FileMatcher = {
  contentType: 'image/avif',
  extensions: ['avif'],
  label: 'AVIF',

  // A conformant AVIF must declare 'avif' (still) or 'avis' (sequence), so their absence is decisive. The registered
  // `image/avif` covers sequences too, hence no separate matcher for 'avis'.
  test: (bytes) => ftypBrandsIncludeAny(ftypBrands(bytes), ['avif', 'avis'])
}

const GIF_TYPE: FileMatcher = {
  contentType: 'image/gif',
  extensions: ['gif'],
  label: 'GIF',

  // Those are the only two versions ever published, so matching the full signature costs nothing over 'GIF8'.
  test: (bytes) => hasSignature(bytes, 'GIF87a') || hasSignature(bytes, 'GIF89a')
}

const HEIC_TYPE: FileMatcher = {
  contentType: 'image/heic',
  extensions: ['heic', 'heif'],
  label: 'HEIC',

  // Per IANA's `image/heic` registration, the subtype applies only to files declaring 'heic', 'heix', 'heim' or
  // 'heis'. Excluded on purpose: 'mif1'/'msf1' are HEIF's structural (container, not codec) brands that every
  // conformant AVIF also declares, so a file carrying only those is `image/heif`, whose codec the header doesn't
  // reveal; 'hevc'/'hevx' are image *sequence* brands (`image/heic-sequence`); 'heif' was never a brand.
  //
  // A multi-codec HEIF can declare both an HEVC and an AVIF brand; its primary item — well past the header — decides
  // which it is. AVIF is matched first and takes the tie by position.
  test: (bytes) => ftypBrandsIncludeAny(ftypBrands(bytes), ['heic', 'heix', 'heim', 'heis'])
}

const JPEG_TYPE: FileMatcher = {
  contentType: 'image/jpeg',
  extensions: ['jpg', 'jpeg', 'jpe', 'jfif'],
  label: 'JPEG',

  // \xff\xd8 is the SOI marker; the trailing \xff is the lead byte of whichever marker follows, and rules out a bare
  // two-byte SOI with nothing after it.
  test: (bytes) => hasSignature(bytes, '\xff\xd8\xff')
}

const PNG_TYPE: FileMatcher = {
  contentType: 'image/png',
  extensions: ['png'],
  label: 'PNG',

  // The bytes around 'PNG' are a deliberate corruption trap: the high bit catches 7-bit-stripping transports, and the
  // \r\n / \n pair catches CRLF translation.
  test: (bytes) => hasSignature(bytes, '\x89PNG\r\n\x1a\n')
}

const WEBP_TYPE: FileMatcher = {
  contentType: 'image/webp',
  extensions: ['webp'],
  label: 'WebP',

  // Bytes 4–7 are the RIFF chunk size, hence the gap.
  test: (bytes) => hasSignature(bytes, 'RIFF') && hasSignature(bytes, 'WEBP', 8)
}

const PDF_TYPE: FileMatcher = {
  contentType: 'application/pdf',
  extensions: ['pdf'],
  label: 'PDF',

  // Readers tolerate junk before the header; the allow-list deliberately does not.
  test: (bytes) => hasSignature(bytes, '%PDF-')
}

/**
 * Every built-in matcher, by name. Each value is the matcher itself, so one drops straight into an `accept` list
 * beside a matcher of your own: `accept: [...IMAGE_TYPES, FILE_TYPES.pdf]`.
 */
export const FILE_TYPES = Object.freeze({
  avif: AVIF_TYPE,
  gif: GIF_TYPE,
  heic: HEIC_TYPE,
  jpeg: JPEG_TYPE,
  png: PNG_TYPE,
  webp: WEBP_TYPE,
  pdf: PDF_TYPE,
  docx: DOCX_TYPE,
  doc: DOC_TYPE,
  odt: ODT_TYPE,
  rtf: RTF_TYPE,
  text: TEXT_TYPE,
  quicktime: QUICKTIME_TYPE,
  mp4: MP4_TYPE,
  threeGPP: THREE_GPP_TYPE,
  webm: WEBM_TYPE,
  matroska: MATROSKA_TYPE
})

/** Image matchers: AVIF, GIF, HEIC, JPEG, PNG, WebP. */
export const IMAGE_TYPES: FileMatcher[] = [
  FILE_TYPES.avif,
  FILE_TYPES.gif,
  FILE_TYPES.heic,
  FILE_TYPES.jpeg,
  FILE_TYPES.png,
  FILE_TYPES.webp
]

/** Video matchers: QuickTime, MP4, 3GP, WebM, Matroska. They name the container, not the codecs inside it. */
export const VIDEO_TYPES: FileMatcher[] = [
  FILE_TYPES.quicktime,
  FILE_TYPES.mp4,
  FILE_TYPES.threeGPP,
  FILE_TYPES.webm,
  FILE_TYPES.matroska
]

/** Image and video matchers. Images come first because AVIF and HEIC share their container with video. */
export const MEDIA_TYPES: FileMatcher[] = [...IMAGE_TYPES, ...VIDEO_TYPES]

/** Word matchers: `.docx` and the older `.doc`. */
export const WORD_TYPES: FileMatcher[] = [FILE_TYPES.docx, FILE_TYPES.doc]

/** Plain-text matchers, which also accept Markdown. */
export const TEXT_TYPES: FileMatcher[] = [FILE_TYPES.text]

/**
 * Document matchers: PDF, Word, OpenDocument text, RTF and plain text, in the order that checks them correctly. RTF
 * and almost any other format are also valid text, so each is tried before the one it could be mistaken for.
 */
export const DOCUMENT_TYPES: FileMatcher[] = [
  FILE_TYPES.pdf,
  ...WORD_TYPES,
  FILE_TYPES.odt,
  FILE_TYPES.rtf,
  ...TEXT_TYPES
]

/**
 * The default allow-list: every built-in matcher. Images precede video, binary documents precede RTF, and plain
 * text comes last, which is the order each needs to be checked in.
 */
export const ALL_TYPES: FileMatcher[] = [...MEDIA_TYPES, ...DOCUMENT_TYPES]

/**
 * Runs a matcher's header test, counting a throw as a failed test.
 *
 * @param matcher - The matcher to try.
 * @param header - The file's leading bytes.
 * @returns `true` when the header test passes.
 */
function passesHeaderTest(matcher: FileMatcher, header: Uint8Array): boolean {
  try {
    return matcher.test(header)
  } catch {
    return false
  }
}

/**
 * Matches already-read header bytes against an allow-list.
 *
 * Matchers are tried in order and the first pass wins, so a list containing overlapping matchers should be ordered
 * most-specific first. A matcher with an {@link FileMatcher.inspect} never matches here, since its type can't be
 * confirmed from the header alone; use {@link sniffType}, which can read the rest of the file.
 *
 * @param header - The file's leading bytes (at most {@link HEADER_BYTES} are needed).
 * @param matchers - The permitted matchers; defaults to {@link ALL_TYPES}.
 * @returns The matched content-type, or `null` when the bytes match nothing on the list.
 */
export function sniffBytes(header: Uint8Array, matchers: readonly FileMatcher[] = ALL_TYPES): string | null {
  for (const matcher of matchers) {
    if (!matcher.inspect && passesHeaderTest(matcher, header)) return matcher.contentType
  }

  return null
}

/**
 * Matches a file's header bytes, and where a matcher asks for it the rest of the file, against an allow-list.
 * Ordering is as for {@link sniffBytes}.
 *
 * @param header - The file's leading bytes (at most {@link HEADER_BYTES} are needed).
 * @param reader - Reads further ranges of the same file, whose budget covers every matcher tried; `undefined`
 *   when the bytes can't be read again, which leaves a matcher with an `inspect` unable to match.
 * @param matchers - The permitted matchers; defaults to {@link ALL_TYPES}.
 * @returns The matched content-type, or `null` when the file matches nothing on the list.
 * @throws {@link ByteRangeReadError} when a matcher's read fails because the bytes couldn't be read, since that
 *   leaves the file's type unknown rather than wrong.
 */
export async function sniffWithReader(
  header: Uint8Array,
  reader: ByteRangeReader | undefined,
  matchers: readonly FileMatcher[] = ALL_TYPES
): Promise<string | null> {
  for (const matcher of matchers) {
    if (!passesHeaderTest(matcher, header)) continue
    if (!matcher.inspect) return matcher.contentType
    if (!reader) continue

    try {
      if ((await matcher.inspect(reader)) === true) return matcher.contentType
    } catch (error) {
      if (error instanceof ByteRangeReadError) throw error
    }
  }

  return null
}

/**
 * The extensions an allow-list saves a content-type under, or `undefined` when its matcher names none.
 *
 * @param contentType - A content-type the allow-list granted.
 * @param matchers - The allow-list it came from.
 * @returns The matcher's extensions, if any.
 */
export function extensionsFor(contentType: string, matchers: readonly FileMatcher[]): readonly string[] | undefined {
  return matchers.find((matcher) => matcher.contentType === contentType)?.extensions
}

/**
 * Sniffs a file's content-type from its bytes against an allow-list. See {@link sniffWithReader}.
 *
 * @param file - The file to inspect.
 * @param matchers - The permitted matchers; defaults to {@link ALL_TYPES}.
 * @returns The matched content-type, or `null` when the file matches nothing on the list.
 */
export async function sniffType(file: File, matchers: readonly FileMatcher[] = ALL_TYPES): Promise<string | null> {
  const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer())
  return sniffWithReader(header, readerForFile(file), matchers)
}

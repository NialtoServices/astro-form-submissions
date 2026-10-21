// Video containers, recognised from the header alone: the brands of an ISO base media `ftyp` atom, the atom QuickTime
// files open with when they predate it, and the document type in a Matroska or WebM file's EBML header. A passing
// matcher names the container, not the codecs inside it.

import { hasSignature } from '#files/matchers/bytes.js'
import { ftypBrands, ftypBrandsIncludeAny } from '#files/matchers/ftyp.js'
import type { FileMatcher } from '#files/sniff.js'

/** Brands that mark an ISO base media file as MP4 video, including the Sony and Apple iPod variants. */
const MP4_BRANDS = [
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
]

/** The atoms a QuickTime file may open with when it has no `ftyp`; every one sits at offset 4, after its size. */
const LEGACY_QUICKTIME_ATOMS = ['moov', 'mdat', 'wide']

/** The whitespace control characters plain text uses: tab, line feed, form feed and carriage return. */
const TEXT_CONTROL_BYTES = [0x09, 0x0a, 0x0c, 0x0d]

/**
 * Tests whether a byte could be part of plain ASCII text.
 *
 * @param byte - The byte to test.
 * @returns `true` for a printable ASCII character or a whitespace control character.
 */
function isTextByte(byte: number): boolean {
  return (byte >= 0x20 && byte <= 0x7e) || TEXT_CONTROL_BYTES.includes(byte)
}

/**
 * Tests whether a header opens with one of the atoms a QuickTime file starts with when it has no `ftyp`.
 *
 * Text can carry the same four letters at offset 4 ("The wide road", or "wide" after four blank lines), so the atom's
 * size, the four bytes before its type, must be a plausible one: at least 8, and not four bytes of text, which are
 * printable ASCII characters, tabs, line feeds, form feeds and carriage returns.
 *
 * @param bytes - The file's leading bytes.
 * @returns `true` when the header opens with a legacy QuickTime atom.
 */
function opensWithLegacyQuickTimeAtom(bytes: Uint8Array): boolean {
  if (!LEGACY_QUICKTIME_ATOMS.some((atom) => hasSignature(bytes, atom, 4))) return false

  const size = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0)
  const sizeLooksLikeText = [...bytes.subarray(0, 4)].every(isTextByte)

  return size >= 8 && !sizeLooksLikeText
}

/**
 * Tests whether a brand belongs to the 3GPP or 3GPP2 families (`3gp4`, `3g2a`, …).
 *
 * @param brand - A brand from an `ftyp` atom.
 * @returns `true` for any brand starting `3gp` or `3g2`.
 */
function isThirdGenerationBrand(brand: string): boolean {
  return brand.startsWith('3gp') || brand.startsWith('3g2')
}

/** QuickTime (`.mov`): the `qt  ` brand, or one of the atoms a file written before `ftyp` existed opens with. */
export const QUICKTIME_TYPE: FileMatcher = {
  contentType: 'video/quicktime',
  extensions: ['mov'],
  label: 'QuickTime',
  test: (bytes) => ftypBrandsIncludeAny(ftypBrands(bytes), ['qt  ']) || opensWithLegacyQuickTimeAtom(bytes)
}

/**
 * MP4 (`.mp4`, `.m4v`): an `ftyp` brand from the MP4 family, which audio-only files such as `.m4a` can also declare,
 * since only the container is checked. A file that also declares a 3GP brand is refused here and left to
 * {@link THREE_GPP_TYPE}, because many encoders write `isom` beside a 3GP brand.
 */
export const MP4_TYPE: FileMatcher = {
  contentType: 'video/mp4',
  extensions: ['mp4', 'm4v'],
  label: 'MP4',
  test: (bytes) => {
    const brands = ftypBrands(bytes)
    return ftypBrandsIncludeAny(brands, MP4_BRANDS) && !brands.some(isThirdGenerationBrand)
  }
}

/** 3GP (`.3gp`, `.3g2`): any `ftyp` brand of the 3GPP or 3GPP2 families. */
export const THREE_GPP_TYPE: FileMatcher = {
  contentType: 'video/3gpp',
  extensions: ['3gp', '3g2'],
  label: '3GP',
  test: (bytes) => ftypBrands(bytes).some(isThirdGenerationBrand)
}

/** Element ID of the document type inside an EBML header. */
const EBML_DOC_TYPE_ID = [0x42, 0x82]

/**
 * Reads an EBML element size: a variable-length integer whose first byte's leading zero bits give its length, with
 * the length marker removed from the value.
 *
 * @param bytes - The bytes to read from.
 * @param offset - Offset of the size's first byte.
 * @returns The size and the bytes it occupies, or `null` when the size is cut off, has no marker bit, or is
 *   longer than 8 bytes.
 */
function readElementSize(bytes: Uint8Array, offset: number): { value: number; length: number } | null {
  const firstByte = bytes[offset]
  if (firstByte === undefined || firstByte === 0) return null

  const length = Math.clz32(firstByte) - 23
  if (offset + length > bytes.length) return null

  let value = firstByte & (0xff >> length)
  for (let index = 1; index < length; index++) value = value * 256 + (bytes[offset + index] ?? 0)

  return { value, length }
}

/**
 * Reads the document type from a leading EBML header.
 *
 * The header is a sequence of elements (ID, size, data) inside an element whose ID is `1A 45 DF A3`; the document
 * type is the one with ID `42 82`, whose data is a short ASCII string.
 *
 * @param bytes - The file's leading bytes.
 * @returns The document type (`webm`, `matroska`, …), or `null` when the header is absent, malformed, cut off before
 *   the type, or names none.
 */
function ebmlDocType(bytes: Uint8Array): string | null {
  if (!hasSignature(bytes, '\x1a\x45\xdf\xa3')) return null

  const headerSize = readElementSize(bytes, 4)
  if (!headerSize) return null

  let offset = 4 + headerSize.length
  const headerEnd = Math.min(offset + headerSize.value, bytes.length)

  while (offset < headerEnd) {
    // Element IDs are variable-length integers of up to 4 bytes that keep their marker bit, so the ID is compared as raw bytes.
    const idLength = Math.clz32(bytes[offset] ?? 0) - 23
    if (idLength < 1 || idLength > 4) return null

    const size = readElementSize(bytes, offset + idLength)
    if (!size) return null

    const dataOffset = offset + idLength + size.length
    if (dataOffset + size.value > bytes.length) return null

    if (
      idLength === EBML_DOC_TYPE_ID.length &&
      EBML_DOC_TYPE_ID.every((byte, index) => bytes[offset + index] === byte)
    ) {
      return String.fromCharCode(...bytes.subarray(dataOffset, dataOffset + size.value))
    }

    offset = dataOffset + size.value
  }

  return null
}

/** WebM (`.webm`): an EBML header whose document type is `webm`. */
export const WEBM_TYPE: FileMatcher = {
  contentType: 'video/webm',
  extensions: ['webm'],
  label: 'WebM',
  test: (bytes) => ebmlDocType(bytes) === 'webm'
}

/** Matroska (`.mkv`): an EBML header whose document type is `matroska`. */
export const MATROSKA_TYPE: FileMatcher = {
  contentType: 'video/x-matroska',
  extensions: ['mkv'],
  label: 'Matroska',
  test: (bytes) => ebmlDocType(bytes) === 'matroska'
}

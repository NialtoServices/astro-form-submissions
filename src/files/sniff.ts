// Magic-byte sniffing for the upload allow-list. The client-supplied MIME type is never trusted (a file can be renamed);
// the content-type returned here is stored on the object and echoed back by the download route. Returns null for anything
// off the allow-list.
//
// A passing matcher means "the leading bytes are well-formed for this type", not "this file is safe": the download route
// still needs `X-Content-Type-Options: nosniff`, and inline PDFs on the app origin need `Content-Disposition: attachment`
// (or a separate, cookieless origin).

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

  /**
   * Tests the file's leading bytes; `true` accepts the file as {@link FileMatcher.contentType}.
   *
   * The array holds at most {@link HEADER_BYTES} bytes and may be **shorter**, so no index can be assumed present.
   * Reading past the end gives `undefined`, which fails every `===` comparison; anything doing arithmetic or slicing
   * needs an explicit length check. A matcher must never throw.
   */
  test: (bytes: Uint8Array) => boolean
}

/**
 * Tests whether `bytes` contains `signature` at `offset`.
 *
 * @param bytes - The file's leading bytes.
 * @param signature - The expected bytes, one per character. Every character must be U+00FF or below; anything higher
 *   cannot appear in a byte and will never match.
 * @param offset - Offset the signature starts at. Defaults to the start of the header.
 * @returns `true` if every byte matches; `false` if any differs or the header is too short to hold the signature.
 */
function hasSignature(bytes: Uint8Array, signature: string, offset = 0): boolean {
  if (offset + signature.length > bytes.length) return false

  for (let index = 0; index < signature.length; index++) {
    if (bytes[offset + index] !== signature.charCodeAt(index)) return false
  }

  return true
}

/**
 * Reads the four-character code at `offset` as a string.
 *
 * @param bytes - The file's leading bytes.
 * @param offset - Offset of the first of the four bytes.
 * @returns The four-character code, or `null` if the header is too short to contain it.
 */
function fourCCAt(bytes: Uint8Array, offset: number): string | null {
  if (offset + 4 > bytes.length) return null

  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

/**
 * Returns every brand declared by a leading ISO-BMFF `ftyp` box — the major brand plus all compatible brands.
 *
 * Box layout: size (4 bytes, big-endian), `ftyp` (4), major brand (4), minor version (4, an integer — *not* a brand),
 * then compatible brands (4 each) until the end of the box.
 *
 * The compatible brands are where the answer usually lives. AVIF requires `avif` or `avis` in the compatible list, not
 * the major slot, and conformant encoders put `mif1` in the major slot often enough that a major-brand-only check
 * misfiles them.
 *
 * @param bytes - The file's leading bytes.
 * @returns The declared brands, or an empty array if the header isn't an `ftyp` box we can parse.
 */
function ftypBrands(bytes: Uint8Array): string[] {
  if (!hasSignature(bytes, 'ftyp', 4)) return []

  // Indices 0–3 are present: the check above passed, and a Uint8Array is contiguous.
  const size = ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!

  // size === 1 means a 64-bit largesize occupies offsets 8–15 and shifts the brands; size === 0 means "box runs to EOF".
  // Neither is legal for `ftyp`, and misparsing one would read brands from the wrong offsets, so decline to guess.
  if (size < 16) return []

  // The box also needs 16 actual bytes present (size + type + major brand + minor version); a file declaring them but
  // ending at the major brand (offsets 8–11) is truncated, so don't trust the brand it appears to carry.
  if (bytes.length < 16) return []

  const major = fourCCAt(bytes, 8)
  if (major === null) return []

  // A box longer than HEADER_BYTES simply has brands we can't see.
  const end = Math.min(size, bytes.length)

  const brands = [major]
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const brand = fourCCAt(bytes, offset)
    if (brand !== null) brands.push(brand)
  }

  return brands
}

/**
 * Tests whether an `ftyp` box declares at least one of `allowed`.
 *
 * @param brands - The brands declared by the box, from {@link ftypBrands}.
 * @param allowed - The brands that satisfy this test.
 * @returns `true` if any declared brand is on `allowed`.
 */
function ftypBrandsIncludeAny(brands: string[], allowed: string[]): boolean {
  return brands.some((brand) => allowed.includes(brand))
}

/** Image matchers: AVIF, GIF, HEIC, JPEG, PNG, WebP. */
export const IMAGE_TYPES: FileMatcher[] = [
  {
    contentType: 'image/avif',
    // A conformant AVIF must declare 'avif' (still) or 'avis' (sequence), so their absence is decisive. The registered
    // `image/avif` covers sequences too, hence no separate matcher for 'avis'.
    test: (bytes) => ftypBrandsIncludeAny(ftypBrands(bytes), ['avif', 'avis'])
  },
  {
    contentType: 'image/gif',
    // Those are the only two versions ever published, so matching the full signature costs nothing over 'GIF8'.
    test: (bytes) => hasSignature(bytes, 'GIF87a') || hasSignature(bytes, 'GIF89a')
  },
  {
    contentType: 'image/heic',
    // Per IANA's `image/heic` registration, the subtype applies only to files declaring 'heic', 'heix', 'heim' or
    // 'heis'. Excluded on purpose: 'mif1'/'msf1' are HEIF's structural (container, not codec) brands that every
    // conformant AVIF also declares, so a file carrying only those is `image/heif`, whose codec the header doesn't
    // reveal; 'hevc'/'hevx' are image *sequence* brands (`image/heic-sequence`); 'heif' was never a brand.
    //
    // A multi-codec HEIF can declare both an HEVC and an AVIF brand; its primary item — well past the header — decides
    // which it is. AVIF is matched first and takes the tie by position.
    test: (bytes) => ftypBrandsIncludeAny(ftypBrands(bytes), ['heic', 'heix', 'heim', 'heis'])
  },
  {
    contentType: 'image/jpeg',
    // \xff\xd8 is the SOI marker; the trailing \xff is the lead byte of whichever marker follows, and rules out a bare
    // two-byte SOI with nothing after it.
    test: (bytes) => hasSignature(bytes, '\xff\xd8\xff')
  },
  {
    contentType: 'image/png',
    // The bytes around 'PNG' are a deliberate corruption trap: the high bit catches 7-bit-stripping transports, and the
    // \r\n / \n pair catches CRLF translation.
    test: (bytes) => hasSignature(bytes, '\x89PNG\r\n\x1a\n')
  },
  {
    contentType: 'image/webp',
    // Bytes 4–7 are the RIFF chunk size, hence the gap.
    test: (bytes) => hasSignature(bytes, 'RIFF') && hasSignature(bytes, 'WEBP', 8)
  }
]

/** Document matchers: PDF. */
export const DOCUMENT_TYPES: FileMatcher[] = [
  {
    contentType: 'application/pdf',
    // Readers tolerate junk before the header; the allow-list deliberately does not.
    test: (bytes) => hasSignature(bytes, '%PDF-')
  }
]

/** The default allow-list: every image and document matcher. */
export const ALL_TYPES: FileMatcher[] = [...IMAGE_TYPES, ...DOCUMENT_TYPES]

/**
 * Sniffs a file's content-type from its header bytes against an allow-list.
 *
 * Matchers are tried in order and the first pass wins, so a list containing overlapping matchers should be ordered
 * most-specific first.
 *
 * @param file - The file to inspect.
 * @param matchers - The permitted matchers; defaults to {@link ALL_TYPES}.
 * @returns The matched content-type, or `null` when the file matches nothing on the list.
 */
export async function sniffType(file: File, matchers: FileMatcher[] = ALL_TYPES): Promise<string | null> {
  const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer())
  for (const matcher of matchers) {
    if (matcher.test(header)) return matcher.contentType
  }

  return null
}

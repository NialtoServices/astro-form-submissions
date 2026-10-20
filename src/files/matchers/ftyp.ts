import { hasSignature } from '#files/matchers/bytes.js'

/**
 * Reads the four-character code at `offset` as a string.
 *
 * @param bytes - The file's leading bytes.
 * @param offset - Offset of the first of the four bytes.
 * @returns The four-character code, or `null` if the header is too short to contain it.
 */
function fourCCAt(bytes: Uint8Array, offset: number): string | null {
  if (offset + 4 > bytes.length) return null

  return String.fromCharCode(...bytes.subarray(offset, offset + 4))
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
export function ftypBrands(bytes: Uint8Array): string[] {
  if (!hasSignature(bytes, 'ftyp', 4)) return []

  // Indices 0–3 are present: the check above passed, and a Uint8Array is contiguous.
  const size = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0)

  // size === 1 means a 64-bit largesize occupies offsets 8–15 and shifts the brands; size === 0 means "box runs to EOF".
  // Neither is legal for `ftyp`, and misparsing one would read brands from the wrong offsets, so decline to guess.
  if (size < 16) return []

  // The box also needs 16 actual bytes present (size + type + major brand + minor version); a file declaring them but
  // ending at the major brand (offsets 8–11) is truncated, so don't trust the brand it appears to carry.
  if (bytes.length < 16) return []

  const major = fourCCAt(bytes, 8)
  if (major === null) return []

  // A box longer than the header simply has brands we can't see.
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
export function ftypBrandsIncludeAny(brands: string[], allowed: string[]): boolean {
  return brands.some((brand) => allowed.includes(brand))
}

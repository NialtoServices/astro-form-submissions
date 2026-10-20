/**
 * Tests whether `bytes` contains `signature` at `offset`.
 *
 * @param bytes - The bytes to look in.
 * @param signature - The expected bytes, one per character. Every character must be U+00FF or below; anything higher
 *   cannot appear in a byte and will never match.
 * @param offset - Offset the signature starts at. Defaults to the start of `bytes`.
 * @returns `true` if every byte matches; `false` if any differs or `bytes` is too short to hold the signature.
 */
export function hasSignature(bytes: Uint8Array, signature: string, offset = 0): boolean {
  if (offset + signature.length > bytes.length) return false

  for (let index = 0; index < signature.length; index++) {
    if (bytes[offset + index] !== signature.charCodeAt(index)) return false
  }

  return true
}

/**
 * A view for reading multi-byte integers out of `bytes`. Its reads throw past the end, so a caller checks a
 * structure's length before reading its fields.
 *
 * @param bytes - The bytes to view, which may be a slice of a larger buffer.
 * @returns A view over exactly `bytes`.
 */
export function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * The bytes encoded per `btoa` call. A multiple of three, so every chunk but the last encodes without padding and
 * the pieces join into the encoding of the whole; close to 32 KiB, which keeps each `String.fromCharCode` call far
 * below the engines' argument limits.
 */
const CHUNK_BYTES = 3 * 10_922

/**
 * Encodes bytes as base64 with the web-standard `btoa`, a chunk at a time, since spreading a multi-megabyte array
 * into `String.fromCharCode` overflows the call stack and Workers has no `Buffer`.
 *
 * @param bytes - The bytes to encode.
 * @returns The padded base64 encoding of `bytes`.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let encoded = ''

  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    encoded += btoa(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_BYTES)))
  }

  return encoded
}

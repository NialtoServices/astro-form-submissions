import type { FileMatcher } from '#files/sniff.js'

const encoder = new TextEncoder()

/** The four bytes a trailer file must start with, which the header test can see. */
const HEAD = 'TRLR'

/** The four bytes it must end with, which only a ranged read can see once the file outgrows the header. */
const TAIL = 'DONE'

/**
 * A matcher for a made-up format whose last four bytes are what make it that format: the header test only
 * checks the start, and `inspect` reads the end.
 */
export const TRAILER_MATCHER: FileMatcher = {
  contentType: 'application/x-trailer',
  extensions: ['trl'],
  label: 'Trailer',
  test: (bytes) => new TextDecoder().decode(bytes.subarray(0, HEAD.length)) === HEAD,
  inspect: async (reader) => {
    if (reader.size < HEAD.length + TAIL.length) return false

    return new TextDecoder().decode(await reader.read(reader.size - TAIL.length, TAIL.length)) === TAIL
  }
}

/**
 * Bytes shaped like the trailer format, long enough that the end lies past the header bytes.
 *
 * @param complete - Whether the file carries its closing bytes, or was cut short.
 */
export function trailerBytes(complete: boolean): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${HEAD}${'.'.repeat(300)}${complete ? TAIL : 'DONT'}`)
}

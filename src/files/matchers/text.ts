import type { FileMatcher } from '#files/sniff.js'

/** How much of each end of a file is checked as text. */
const TEXT_SAMPLE_BYTES = 4 * 1024

/** The control characters text may hold: tab, line feed, form feed and carriage return. */
const PERMITTED_CONTROL_CHARACTERS = new Set([0x09, 0x0a, 0x0c, 0x0d])

/** The most continuation bytes a UTF-8 character can have, so the most a slice can start inside one. */
const MAX_CONTINUATION_BYTES = 3

/**
 * Tests whether a slice of a file is UTF-8 text: valid encoding, and no control characters but tab, line feed,
 * form feed and carriage return.
 *
 * @param bytes - The slice.
 * @param continuesBefore - Whether bytes precede the slice in the file, so it may start partway through a character.
 * @param continuesAfter - Whether bytes follow the slice in the file, so it may end partway through a character.
 * @returns `true` when the slice is text as far as it can be checked; never throws.
 */
function isText(bytes: Uint8Array, continuesBefore: boolean, continuesAfter: boolean): boolean {
  let start = 0
  if (continuesBefore) {
    while (start < MAX_CONTINUATION_BYTES && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start), { stream: continuesAfter })
  } catch {
    return false
  }

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x20 && !PERMITTED_CONTROL_CHARACTERS.has(code)) return false
    if (code >= 0x7f && code <= 0x9f) return false
  }

  return true
}

/**
 * Plain text (`.txt`, `.md`): UTF-8, with or without a byte-order mark, whose first and last 4 KiB hold no control
 * characters but tab, line feed, form feed and carriage return. Almost any other format is also valid text at
 * one end or the other, so an allow-list checks this matcher last.
 */
export const TEXT_TYPE: FileMatcher = {
  contentType: 'text/plain',
  extensions: ['txt', 'md'],
  label: 'Text',
  test: (bytes) => bytes.length > 0 && isText(bytes, false, true),
  inspect: async (reader) => {
    if (reader.size === 0) return false

    const headLength = Math.min(reader.size, TEXT_SAMPLE_BYTES)
    const head = await reader.read(0, headLength)
    if (head.length !== headLength || !isText(head, false, headLength < reader.size)) return false
    if (headLength === reader.size) return true

    const tailStart = Math.max(headLength, reader.size - TEXT_SAMPLE_BYTES)
    const tail = await reader.read(tailStart, reader.size - tailStart)
    return tail.length === reader.size - tailStart && isText(tail, true, false)
  }
}

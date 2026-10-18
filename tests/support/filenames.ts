import fc from 'fast-check'
import { expect } from 'vitest'

/**
 * Pieces of a filename that the naming rules treat specially, weighted in alongside arbitrary text so the
 * generator reaches them far more often than chance would: separators and trailing characters Windows drops,
 * header and attribute breakers, bidirectional controls, a lone surrogate, and extensions a script runs under.
 */
const FILENAME_PIECES = [
  '.',
  '..',
  ' ',
  '\t',
  '\u00A0',
  '\u3000',
  '\r',
  '\n',
  '"',
  '\u202E',
  '\u2066',
  '\u200F',
  '\u061C',
  '\u200D',
  '\uD800',
  '\u{1F4C4}',
  'js',
  'hta',
  'pdf',
  'PDF',
  'é'.repeat(40),
  '\u{1F4C4}'.repeat(100)
]

/** A sequence of special pieces and arbitrary text, joined. */
const mixedPieces = fc
  .array(
    fc.oneof(
      { arbitrary: fc.constantFrom(...FILENAME_PIECES), weight: 3 },
      { arbitrary: fc.string({ unit: 'binary' }), weight: 1 }
    ),
    { maxLength: 24 }
  )
  .map((pieces) => pieces.join(''))

/**
 * A name that reaches the 200-character cap partway through its pieces, so the cut lands on every kind of
 * character: a dot, a space, a surrogate pair, the middle of an extension.
 */
const nameAcrossTheCap = fc
  .tuple(fc.integer({ min: 170, max: 200 }), mixedPieces)
  .map(([length, pieces]) => 'a'.repeat(length) + pieces)

/** A filename as a browser might report it, honest or hostile, from empty to well past the length cap. */
export const browserFilename = fc.oneof(mixedPieces, nameAcrossTheCap)

/** The longest stored filename, in characters, that the README promises. */
const MAX_STORED_FILENAME_LENGTH = 200

/**
 * Asserts the promises every stored filename keeps, whatever the browser sent: present, well-formed, at
 * most 200 characters, free of anything that breaks a header or a quoted attribute or disguises the name,
 * and without the trailing dots or whitespace Windows drops when saving.
 */
export function expectSafeStoredName(name: string): void {
  expect(name).not.toBe('')
  expect(name.isWellFormed()).toBe(true)
  expect([...name].length).toBeLessThanOrEqual(MAX_STORED_FILENAME_LENGTH)
  expect(name).not.toMatch(/[\r\n"\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u)
  expect(name).not.toMatch(/[.\s]$/u)
}

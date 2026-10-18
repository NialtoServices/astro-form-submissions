/** The name a file is stored and linked under when the browser's name is empty or nothing but stripped characters. */
const FALLBACK_FILENAME = 'upload'

/**
 * The bidirectional text controls, which can make a name read as something it isn't (`invoice[U+202E]fdp.js`
 * shows as `invoicesj.pdf`). Other invisible format characters, such as the joiners in emoji sequences and in
 * Persian and Kurdish words, are kept.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu

/** Trailing dots and whitespace, which Windows drops when saving a file. */
const TRAILING_DOTS_AND_WHITESPACE = /[.\s]+$/u

/**
 * The longest name stored, in characters. Percent-encoded, a name can take twelve bytes a character, and R2
 * refuses an object whose custom metadata passes 8 KB, so an unbounded name would fail the store.
 */
const MAX_FILENAME_LENGTH = 200

/** The longest trailing part kept as an extension when a long name is shortened. */
const MAX_KEPT_EXTENSION_LENGTH = 16

/** Shortens a name to {@link MAX_FILENAME_LENGTH} characters, keeping a short extension on the end. */
function shortened(name: string): string {
  if ([...name].length <= MAX_FILENAME_LENGTH) return name

  const dotIndex = name.lastIndexOf('.')
  const extension = dotIndex > 0 && name.length - dotIndex <= MAX_KEPT_EXTENSION_LENGTH + 1 ? name.slice(dotIndex) : ''
  const base = [...name.slice(0, name.length - extension.length)]
  return base.slice(0, MAX_FILENAME_LENGTH - [...extension].length).join('') + extension
}

/**
 * The filename stored with an upload and shown in its link: the browser's name made well-formed (a lone
 * UTF-16 surrogate becomes U+FFFD, since `encodeURIComponent` throws on one), without CR, LF or `"`, which
 * would break a header or a quoted attribute, without bidirectional text controls, without trailing dots or
 * whitespace, which Windows drops when saving (so `invoice.js.` would be saved as `invoice.js`), and no longer
 * than {@link MAX_FILENAME_LENGTH} characters, keeping its extension; or `upload` when nothing is left. With `extensions`, the name also ends in one of them. Shared by both upload
 * paths so a file is named the same way whichever one it took.
 *
 * @param name - The filename the browser reported.
 * @param extensions - The extensions the file's checked type is saved under, if known.
 * @returns The name to store.
 */
export function storedFilename(name: string, extensions?: readonly string[]): string {
  const trimmed = name
    .toWellFormed()
    .replace(/[\r\n"]/g, '')
    .replace(BIDI_CONTROLS, '')
    .replace(TRAILING_DOTS_AND_WHITESPACE, '')

  // Shortening can cut a name just after a dot or a space, so its result is trimmed the same way.
  const cleaned = shortened(trimmed).replace(TRAILING_DOTS_AND_WHITESPACE, '') || FALLBACK_FILENAME
  const preferred = extensions?.[0]
  if (preferred === undefined || hasExtension(cleaned, extensions)) return cleaned

  return `${cleaned}.${preferred}`
}

/**
 * Whether a filename ends in one of `extensions`, ignoring case on both sides.
 *
 * @param name - The filename to check.
 * @param extensions - The accepted extensions, without the dot.
 * @returns `true` when the name's last extension is among them.
 */
export function hasExtension(name: string, extensions: readonly string[] | undefined): boolean {
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex < 0 || !extensions) return false

  const extension = name.slice(dotIndex + 1).toLowerCase()
  return extensions.some((candidate) => candidate.toLowerCase() === extension)
}

/**
 * Whether a filename carries any extension at all. A leading dot counts, since Windows opens `.js` as a script.
 *
 * @param name - The filename to check.
 * @returns `true` when something follows the last dot.
 */
export function hasAnyExtension(name: string): boolean {
  const dotIndex = name.lastIndexOf('.')
  return dotIndex >= 0 && dotIndex < name.length - 1
}

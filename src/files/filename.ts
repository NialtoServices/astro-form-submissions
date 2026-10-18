/** The name a file is stored and linked under when the browser's name is empty or nothing but stripped characters. */
const FALLBACK_FILENAME = 'upload'

/**
 * The bidirectional text controls, which can make a name read as something it isn't (`invoice[U+202E]fdp.js`
 * shows as `invoicesj.pdf`). Other invisible format characters, such as the joiners in emoji sequences and in
 * Persian and Kurdish words, are kept.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu

/**
 * The filename stored with an upload and shown in its link: the browser's name made well-formed (a lone
 * UTF-16 surrogate becomes U+FFFD, since `encodeURIComponent` throws on one), without CR, LF or `"`, which
 * would break a header or a quoted attribute, without bidirectional text controls, and without trailing dots
 * or whitespace, which Windows drops when saving (so `invoice.js.` would be saved as `invoice.js`); or
 * `upload` when nothing is left. With `extensions`, the name also ends in one of them. Shared by both upload
 * paths so a file is named the same way whichever one it took.
 *
 * @param name - The filename the browser reported.
 * @param extensions - The extensions the file's checked type is saved under, if known.
 * @returns The name to store.
 */
export function storedFilename(name: string, extensions?: readonly string[]): string {
  const cleaned =
    name
      .toWellFormed()
      .replace(/[\r\n"]/g, '')
      .replace(BIDI_CONTROLS, '')
      .replace(/[.\s]+$/u, '') || FALLBACK_FILENAME
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

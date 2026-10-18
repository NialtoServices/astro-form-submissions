/** The name a file is stored and linked under when the browser's name is empty or nothing but stripped characters. */
const FALLBACK_FILENAME = 'upload'

/**
 * The filename stored with an upload and shown in its link: the browser's name made well-formed (a lone
 * UTF-16 surrogate becomes U+FFFD, since `encodeURIComponent` throws on one), without CR, LF or `"`, which
 * would break a header or a quoted attribute, and without invisible format characters such as U+202E, which
 * can make a name read as something it isn't, or `upload` when nothing is left. With `extensions`, the name
 * also ends in one of them. Shared by both upload paths so a file is named the same way whichever one it took.
 *
 * @param name - The filename the browser reported.
 * @param extensions - The extensions the file's checked type is saved under, if known.
 * @returns The name to store.
 */
export function storedFilename(name: string, extensions?: readonly string[]): string {
  const cleaned = name.toWellFormed().replace(/[\r\n"\p{Cf}]/gu, '') || FALLBACK_FILENAME
  const preferred = extensions?.[0]
  if (preferred === undefined || hasExtension(cleaned, extensions)) return cleaned

  return `${cleaned}.${preferred}`
}

/**
 * Whether a filename ends in one of `extensions`, ignoring case.
 *
 * @param name - The filename to check.
 * @param extensions - The accepted extensions, without the dot.
 * @returns `true` when the name's last extension is among them.
 */
export function hasExtension(name: string, extensions: readonly string[] | undefined): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || !extensions) return false

  return extensions.includes(name.slice(dot + 1).toLowerCase())
}

/**
 * Whether a filename carries any extension at all.
 *
 * @param name - The filename to check.
 * @returns `true` when something follows a dot that isn't the first or last character.
 */
export function hasAnyExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1
}

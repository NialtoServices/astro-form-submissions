/** The name a file is stored and linked under when the browser's name is empty or nothing but stripped characters. */
const FALLBACK_FILENAME = 'upload'

/**
 * The filename stored with an upload and shown in its link: the browser's name without CR, LF or `"`,
 * which would break a header or a quoted attribute, or `upload` when nothing is left. Shared by both
 * upload paths so a file is named the same way whichever one it took.
 *
 * @param name - The filename the browser reported.
 * @returns The name to store.
 */
export function storedFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '') || FALLBACK_FILENAME
}

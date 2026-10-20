import { hasSignature } from '#files/matchers/bytes.js'
import type { FileMatcher } from '#files/sniff.js'

/**
 * Rich Text Format (`.rtf`): a file that starts with the `{\rtf` group every RTF document opens with. RTF is
 * also plain text, so an allow-list holding both checks this matcher first.
 */
export const RTF_TYPE: FileMatcher = {
  contentType: 'application/rtf',
  extensions: ['rtf'],
  label: 'RTF',
  test: (bytes) => hasSignature(bytes, '{\\rtf')
}

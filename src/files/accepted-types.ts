import type { FileMatcher } from '#files/sniff.js'

/** Stands in for the accepted types when none of the accepted matchers carries a label. */
const UNLABELLED_TYPES = 'a supported file type'

/**
 * Joins items for a sentence: `PDF`, `JPEG or PDF`, `JPEG, PNG or PDF`.
 *
 * @param items - The items to join.
 * @returns The joined text, empty for no items.
 */
function joinAlternatives(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')

  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/**
 * Names the accepted types for a sentence, from the matchers' labels: `JPEG, PNG or PDF`. A label shared by
 * several matchers (`.docx` and `.doc` are both `Word`) is named once.
 *
 * @param accept - The accepted matchers.
 * @returns The labels joined as alternatives, or `a supported file type` when no matcher has a label.
 */
export function describeAcceptedTypes(accept: readonly FileMatcher[]): string {
  const labels = [...new Set(accept.flatMap((matcher) => (matcher.label ? [matcher.label] : [])))]

  return labels.length > 0 ? joinAlternatives(labels) : UNLABELLED_TYPES
}

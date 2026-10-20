/**
 * Truncate `value` to at most `maximum` code points, appending an ellipsis when shortened. Slicing by code point (not
 * UTF-16 unit) never leaves a lone surrogate from a split astral character, which strict consumers reject.
 *
 * @param value - The string to truncate.
 * @param maximum - The maximum number of code points to keep.
 * @returns The truncated string, with an ellipsis if it was shortened.
 */
export function clamp(value: string, maximum: number): string {
  if (maximum <= 0) return ''

  const codePoints = [...value]
  return codePoints.length > maximum ? codePoints.slice(0, maximum - 1).join('') + '…' : value
}

/**
 * Turn a field key into a human-readable label.
 *
 * - `APIKey` → `API Key`
 * - `email` → `Email`
 * - `preferredTime` → `Preferred Time`
 * - `preferred_time` → `Preferred Time`
 *
 * @param key - The field key to humanise.
 * @returns The humanised label.
 */
export function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

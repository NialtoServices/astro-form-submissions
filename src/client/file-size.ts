const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Format a byte count as a human-readable size, e.g. `2.5 MB` or `315 KB`. Steps up through
 * binary (1024-based) units, showing one decimal place from `MB` upward and none below.
 *
 * @param bytes - The size in bytes.
 * @returns The formatted size, or an empty string for a negative or non-finite input.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''

  const decimalsFor = (unitIndex: number) => (unitIndex >= 2 ? 1 : 0)

  // Steps up on the rounded value, so a size just under a unit boundary (1,048,575 bytes) reads `1 MB`
  // rather than `1024 KB`.
  let size = bytes
  let unitIndex = 0
  while (unitIndex < FILE_SIZE_UNITS.length - 1 && Number(size.toFixed(decimalsFor(unitIndex))) >= 1024) {
    size /= 1024
    unitIndex++
  }

  const formatted = size.toFixed(decimalsFor(unitIndex)).replace(/\.0$/, '')
  return `${formatted} ${FILE_SIZE_UNITS[unitIndex]}`
}

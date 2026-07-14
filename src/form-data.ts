/**
 * Read a form field as a trimmed string, or `undefined` when absent/blank; never the literal string `"null"` that
 * `` `${data.get(name)}` `` would yield.
 */
export function getField(data: FormData, name: string): string | undefined {
  const value = data.get(name)
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

/** Small runtime type guards shared across the pipeline for narrowing values at `unknown` boundaries. */

/**
 * Narrows an `unknown` to a plain string-keyed record. Arrays and `null` are objects to `typeof` but
 * are not records here, so keyed reads (`value.foo`) mean what the caller intends.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

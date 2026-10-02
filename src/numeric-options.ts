// Numeric options are usually read from configuration (`Number(env.X)`), where an unset variable becomes
// `NaN`. Every comparison against `NaN` is false, so an unchecked limit silently stops limiting and an
// unchecked lifetime mints tokens that never verify; constructors therefore reject them up front.

/** The bounds a numeric option must satisfy beyond being finite and positive. */
interface NumericBounds {
  /** Whether the value must be a whole number. */
  integer?: boolean

  /** The largest accepted value. */
  maximum?: number
}

/**
 * Fail fast on a numeric option that is not a finite positive number (and, when asked, a whole number no
 * larger than `maximum`). An `undefined` value passes, since the caller applies its default.
 *
 * @param label - Names the owner and option for the message, e.g. ``'UploadedFiles `maxFiles`'``.
 * @param value - The configured value.
 * @param bounds - Extra constraints on the value.
 * @throws When the value is out of bounds.
 */
export function assertPositiveNumberOption(
  label: string,
  value: number | undefined,
  { integer = false, maximum = Infinity }: NumericBounds = {}
): void {
  if (value === undefined) return

  const kind = integer ? 'integer' : 'number'
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be a finite positive ${kind}.`)
  }

  if (value > maximum) throw new Error(`${label} must be at most ${maximum}.`)
}

/** The file limits {@link assertFileLimitOptions} checks. */
interface FileLimitOptions {
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

/**
 * Fail fast on file limits that would silently stop limiting (`NaN`) or refuse every file (zero or less).
 *
 * @param owner - The constructor or factory the limits belong to, for the message.
 * @param limits - The configured limits.
 * @throws When any limit is out of bounds.
 */
export function assertFileLimitOptions(owner: string, limits: FileLimitOptions): void {
  assertPositiveNumberOption(`${owner} \`maxFiles\``, limits.maxFiles, { integer: true })
  assertPositiveNumberOption(`${owner} \`maxFileBytes\``, limits.maxFileBytes)
  assertPositiveNumberOption(`${owner} \`maxTotalBytes\``, limits.maxTotalBytes)
}

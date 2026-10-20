/**
 * A ranged read that failed because the file's bytes couldn't be read (a storage outage, an object gone since
 * it was peeked), as opposed to one the budget refused. A type check lets it propagate, since it says nothing
 * about the file's type. Its `cause` is the failure the source of the bytes gave.
 */
export class ByteRangeReadError extends Error {
  // MARK: - Object Lifecycle

  constructor(
    readonly offset: number,
    readonly length: number,
    options?: ErrorOptions
  ) {
    super(`Failed to read ${length} byte(s) at offset ${offset} while checking a file's type.`, options)
    this.name = 'ByteRangeReadError'
  }
}

import { ByteRangeReadError } from '#files/byte-range-read-error.js'
import type { FileStorage } from '#storage/storage.js'

/**
 * The most bytes a matcher's {@link FileMatcher.inspect} may read from one file in all, across every matcher
 * tried against it. A read that would take the total past this is rejected.
 */
export const MAX_INSPECTED_BYTES = 64 * 1024

/**
 * The most reads a matcher's {@link FileMatcher.inspect} may make against one file in all, across every matcher
 * tried against it, so a type check costs a bounded number of storage round trips. A read past this is rejected.
 */
export const MAX_INSPECTED_READS = 4

/** Random access to a file's bytes, for a type check that needs more than the file's first {@link HEADER_BYTES}. */
export interface ByteRangeReader {
  /** The file's total size in bytes. */
  readonly size: number

  /**
   * Reads up to `length` bytes starting at `offset`. A range that runs past the end of the file yields only the
   * bytes that exist, and a range wholly past it yields none.
   *
   * @param offset - The index of the first byte; a non-negative integer.
   * @param length - How many bytes to read; a non-negative integer.
   * @returns The bytes read, never more than `length`.
   * @throws A `RangeError` when the range is invalid, or when it would exceed {@link MAX_INSPECTED_BYTES} or
   * {@link MAX_INSPECTED_READS} for the file; any other error when the bytes can't be read, which a type
   * check doesn't count as a mismatch.
   */
  read(offset: number, length: number): Promise<Uint8Array>
}

/**
 * Wraps a source of byte ranges in the per-file budget, so no matcher can read more than the limits allow
 * whatever it asks for, or whatever the source returns. A source's failure becomes a {@link ByteRangeReadError}.
 *
 * @param size - The file's total size in bytes.
 * @param readSlice - Reads a range already known to lie within the file.
 */
function budgetedReader(
  size: number,
  readSlice: (offset: number, length: number) => Promise<Uint8Array>
): ByteRangeReader {
  let readCount = 0
  let byteCount = 0

  return {
    size,
    async read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
        throw new RangeError('A byte range needs a non-negative integer offset and length.')
      }

      readCount++
      if (readCount > MAX_INSPECTED_READS) {
        throw new RangeError(`A file may be read at most ${MAX_INSPECTED_READS} times when checking its type.`)
      }

      const available = Math.min(length, Math.max(0, size - offset))
      if (byteCount + available > MAX_INSPECTED_BYTES) {
        throw new RangeError(`A file may be read at most ${MAX_INSPECTED_BYTES} bytes in all when checking its type.`)
      }

      if (available === 0) return new Uint8Array(0)

      byteCount += available

      let bytes: Uint8Array
      try {
        bytes = await readSlice(offset, available)
      } catch (error) {
        throw new ByteRangeReadError(offset, available, { cause: error })
      }

      return bytes.length > available ? bytes.subarray(0, available) : bytes
    }
  }
}

/**
 * A budgeted reader over an in-request file.
 *
 * @param file - The file to read from.
 * @returns A reader for `file`, whose budget is spent across every read made through it.
 */
export function readerForFile(file: File): ByteRangeReader {
  return budgetedReader(
    file.size,
    async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  )
}

/**
 * A budgeted reader over a stored object, using the storage's `readRange`.
 *
 * @param storage - The storage holding the object.
 * @param key - The object's logical key.
 * @param size - The object's total size in bytes, as the storage reported it.
 * @returns A reader for the object, or `undefined` when the storage has no `readRange`, in which case a type
 * that needs ranged reads can't be confirmed.
 */
export function readerForStorage(storage: FileStorage, key: string, size: number): ByteRangeReader | undefined {
  if (typeof storage.readRange !== 'function') return undefined

  const readRange = storage.readRange.bind(storage)
  return budgetedReader(size, async (offset, length) => {
    const bytes = await readRange(key, offset, length)
    if (bytes === null) throw new Error('The object no longer exists.')

    return bytes
  })
}

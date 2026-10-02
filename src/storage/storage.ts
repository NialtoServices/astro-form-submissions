/** A stored object read back for download. */
export interface StoredObject {
  /** The object's byte stream, for streaming to the client. */
  body: ReadableStream

  /** The stored content-type, echoed on download; optional — a store that omits it falls back to `application/octet-stream`. */
  contentType?: string

  /**
   * The original filename (tokens are opaque). `createFileRoute` builds the download's always-`attachment`
   * `Content-Disposition` from it; adapters can't supply a disposition, so stored bytes never serve `inline`.
   * Optional, with a generic fallback.
   */
  filename?: string
}

/** Metadata attached when storing a file, so the download route can echo it back. */
export interface PutOptions {
  /**
   * The content-type to store: sniffed from the bytes for a multipart upload; for a streamed upload, the
   * type the upload route admitted, which `UploadedFiles` checks against the bytes on submission. Never
   * the client-supplied MIME unchecked.
   */
  contentType: string

  /** The original filename, for the download's `Content-Disposition`. */
  filename: string
}

/** Metadata for a streamed upload, whose bytes arrive with a size already checked by the caller. */
export interface StreamPutOptions extends PutOptions {
  /** The body's exact length in bytes. */
  size: number
}

/** The leading bytes of a stored object, with its total size and stored type, for verifying an upload. */
export interface PeekedObject {
  /** The object's total size in bytes. */
  size: number

  /** The content-type the object was stored with, if any. */
  contentType?: string

  /** Up to the requested number of the object's first bytes. */
  header: Uint8Array
}

/**
 * A pluggable object store for uploaded files: pure put/get/delete, no signing or validation.
 * Implement this to back uploads with a provider (R2, S3, …) — {@link FileUploads} and
 * {@link createFileRoute} stay unchanged.
 */
export interface FileStorage {
  /**
   * Stores a file under a key.
   *
   * @param key - The logical object key (storage may namespace it further).
   * @param file - The file to store.
   * @param options - The content-type and filename to persist with the object.
   * @throws On storage failure — {@link FileUploads} treats this as an upload failure and rolls back.
   */
  put(key: string, file: File, options: PutOptions): Promise<void>

  /**
   * Fetches a stored object.
   *
   * @param key - The logical object key.
   * @returns The object's stream, or `null` when it no longer exists.
   */
  get(key: string): Promise<StoredObject | null>

  /**
   * Deletes a stored object. Must not throw for an already-absent key.
   *
   * @param key - The logical object key.
   */
  delete(key: string): Promise<void>

  /**
   * Stores a byte stream of known length under a key, without buffering it. Needed by
   * {@link createUploadPutRoute}.
   *
   * @param key - The logical object key.
   * @param body - The bytes to store.
   * @param options - The content-type, filename and exact size to persist with the object.
   * @throws On storage failure, or when the stream's length differs from `options.size`.
   */
  putStream?(key: string, body: ReadableStream, options: StreamPutOptions): Promise<void>

  /**
   * Reads an object's total size, stored type and first `length` bytes, without fetching the rest.
   * Needed by {@link UploadedFiles} to verify a direct upload.
   *
   * @param key - The logical object key.
   * @param length - How many leading bytes to read.
   * @returns The peeked object, or `null` when it does not exist.
   */
  peek?(key: string, length: number): Promise<PeekedObject | null>
}

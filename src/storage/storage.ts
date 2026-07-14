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
  /** The sniffed content-type (never the client-supplied MIME). */
  contentType: string

  /** The original filename, for the download's `Content-Disposition`. */
  filename: string
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
}

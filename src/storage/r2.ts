import { attachmentDisposition } from '#content-disposition.js'
import { type FileStorage, type PutOptions, type StoredObject } from '#storage/storage.js'

/**
 * The slice of Cloudflare's `R2Bucket` binding {@link R2Storage} uses. Declared structurally so the
 * toolkit needs no `@cloudflare/workers-types` dependency — a real `env.<BUCKET>` binding satisfies it.
 */
export interface R2BucketLike {
  /** Stores the file under `key` with the given HTTP + custom metadata. */
  put(
    key: string,
    value: File,
    options: {
      httpMetadata: { contentType: string; contentDisposition: string }
      customMetadata: { filename: string }
    }
  ): Promise<unknown>

  /** Fetches the object (with its stored metadata), or `null` when absent. */
  get(key: string): Promise<{
    body: ReadableStream
    httpMetadata?: { contentType?: string; contentDisposition?: string }
    customMetadata?: { filename?: string }
  } | null>

  /** Deletes the object; a no-op for an already-absent key. */
  delete(key: string): Promise<void>
}

/** Options for constructing an {@link R2Storage}. */
export interface R2StorageOptions {
  /** The R2 bucket binding (e.g. `env.UPLOADS_BUCKET`). */
  bucket: R2BucketLike

  /**
   * Key prefix applied to every stored object (e.g. `uploads/`). Scope a bucket lifecycle rule to
   * this prefix to auto-expire old uploads. Changing it invalidates links to existing objects.
   */
  prefix?: string
}

/**
 * A {@link FileStorage} backed by a Cloudflare R2 bucket, for use **inside a Cloudflare Worker**
 * where the runtime provides the bucket as a native binding ({@link R2StorageOptions.bucket}). Owns
 * the key prefix so callers work with bare logical keys, and stores files with an `attachment`
 * disposition so a download can never render inline.
 *
 * Reaching R2 from a non-Workers process uses the S3-compatible endpoint, which belongs in a separate
 * `S3Storage` adapter rather than a second construction path here.
 */
export class R2Storage implements FileStorage {
  // MARK: - Object Lifecycle

  /**
   * Creates an R2-backed storage.
   *
   * @param options - The bucket binding and optional key prefix.
   */
  constructor(private readonly options: R2StorageOptions) {}

  // MARK: - FileStorage

  async put(key: string, file: File, options: PutOptions): Promise<void> {
    await this.options.bucket.put(this.prefixed(key), file, {
      httpMetadata: {
        contentType: options.contentType,
        // Stored on the object so a directly-served bucket still downloads rather than renders; the
        // toolkit's download route rebuilds this header from the filename anyway.
        contentDisposition: attachmentDisposition(options.filename)
      },
      customMetadata: { filename: options.filename }
    })
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.options.bucket.get(this.prefixed(key))
    if (!object) return null

    // Echo the metadata stored at `put` time so the opaque download token needn't carry filename/content-type.
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType,
      filename: object.customMetadata?.filename
    }
  }

  delete(key: string): Promise<void> {
    return this.options.bucket.delete(this.prefixed(key))
  }

  // MARK: - Keys

  private prefixed(key: string): string {
    return `${this.options.prefix ?? ''}${key}`
  }
}

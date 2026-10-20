import { attachmentDisposition } from '#content-disposition.js'
import { ObjectExistsError } from '#storage/object-exists-error.js'
import type { FileStorage, PeekedObject, PutOptions, StoredObject, StreamPutOptions } from '#storage/storage.js'

/**
 * The slice of Cloudflare's `R2Bucket` binding {@link R2Storage} uses. Declared structurally so the
 * toolkit needs no `@cloudflare/workers-types` dependency — a real `env.<BUCKET>` binding satisfies it.
 * Anything else standing in for one must honour `put`'s `onlyIf` and resolve `null` when it fails: upload
 * grants and receipts are single-use only because those writes can't replace an existing object.
 */
export interface R2BucketLike {
  /**
   * Stores a file, a known-length byte stream or a string under `key` with the given HTTP + custom
   * metadata. With `onlyIf`, stores only when those conditional headers hold, and resolves `null` when
   * they don't.
   */
  put(
    key: string,
    value: File | ReadableStream | string,
    options: {
      httpMetadata?: { contentType: string; contentDisposition: string }
      customMetadata?: { filename: string }
      onlyIf?: Headers
    }
  ): Promise<unknown>

  /**
   * Fetches the object (with its stored metadata), or `null` when absent. With `range`, the body holds
   * only those bytes while `size` stays the whole object's.
   */
  get(
    key: string,
    options?: { range: { offset: number; length: number } }
  ): Promise<{
    body: ReadableStream
    size?: number
    arrayBuffer?(): Promise<ArrayBuffer>
    httpMetadata?: { contentType?: string; contentDisposition?: string }
    customMetadata?: Record<string, string | undefined>
  } | null>

  /** Deletes the object; a no-op for an already-absent key. */
  delete(key: string): Promise<void>
}

/**
 * The filename a presigned upload stored, percent-encoded because S3 metadata headers must be ASCII.
 * Malformed encoding yields `undefined`, so the download falls back to a generic name.
 */
function decodedFilename(encoded: string | undefined): string | undefined {
  if (encoded === undefined) return undefined

  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

/** The suffix of the empty object that records a claim on the object beside it (see {@link R2Storage.claim}). */
const CLAIM_MARKER_SUFFIX = '.claimed'

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

  // MARK: - FileStorage API

  async put(key: string, file: File, options: PutOptions): Promise<void> {
    await this.options.bucket.put(this.prefixed(key), file, this.metadata(options))
  }

  async putStream(key: string, body: ReadableStream, options: StreamPutOptions): Promise<void> {
    // Once a submission has claimed a key, its object may since have been deleted (a refusal, a rollback, an
    // erasure request), and a grant still within its lifetime must not write a fresh one there.
    const marker = await this.options.bucket.get(this.prefixed(`${key}${CLAIM_MARKER_SUFFIX}`))
    if (marker) {
      await marker.body.cancel()
      await body.cancel()
      throw new ObjectExistsError(key)
    }

    // Workers only stores a stream of known length; FixedLengthStream declares it and errors the write
    // if the bytes run short or long. It exists only in the Workers runtime (Miniflare included).
    const FixedLength = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream })
      .FixedLengthStream
    const value = FixedLength ? body.pipeThrough(new FixedLength(options.size)) : body

    // A grant stays valid for its whole lifetime while the bytes are type-checked only on submission, so an
    // object that could be rewritten later would reach the recipient unchecked.
    const stored = await this.options.bucket.put(this.prefixed(key), value, {
      ...this.metadata(options),
      onlyIf: new Headers({ 'If-None-Match': '*' })
    })
    if (stored === null) throw new ObjectExistsError(key)
  }

  async claim(key: string): Promise<boolean> {
    // The marker sits beside the object under the same prefix, so the lifecycle rule removes both.
    const marker = await this.options.bucket.put(this.prefixed(`${key}${CLAIM_MARKER_SUFFIX}`), '', {
      onlyIf: new Headers({ 'If-None-Match': '*' })
    })
    return marker !== null
  }

  async peek(key: string, length: number): Promise<PeekedObject | null> {
    const object = await this.options.bucket.get(this.prefixed(key), { range: { offset: 0, length } })
    if (!object) return null

    if (typeof object.size !== 'number' || typeof object.arrayBuffer !== 'function') {
      throw new Error('R2Storage.peek needs a bucket whose objects expose `size` and `arrayBuffer()`.')
    }

    return {
      size: object.size,
      contentType: object.httpMetadata?.contentType,
      header: new Uint8Array(await object.arrayBuffer()).subarray(0, length)
    }
  }

  async readRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
    const object = await this.options.bucket.get(this.prefixed(key), { range: { offset, length } })
    if (!object) return null

    if (typeof object.arrayBuffer !== 'function') {
      throw new Error('R2Storage.readRange needs a bucket whose objects expose `arrayBuffer()`.')
    }

    return new Uint8Array(await object.arrayBuffer())
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.options.bucket.get(this.prefixed(key))
    if (!object) return null

    // Echo the metadata stored at `put` time so the opaque download token needn't carry filename/content-type.
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType,
      filename: object.customMetadata?.filename ?? decodedFilename(object.customMetadata?.['filename-uri'])
    }
  }

  delete(key: string): Promise<void> {
    return this.options.bucket.delete(this.prefixed(key))
  }

  // MARK: - Keys and Metadata

  private metadata(options: PutOptions) {
    return {
      httpMetadata: {
        contentType: options.contentType,

        // Stored on the object so a directly-served bucket still downloads rather than renders; the
        // toolkit's download route rebuilds this header from the filename anyway.
        contentDisposition: attachmentDisposition(options.filename)
      },
      customMetadata: { filename: options.filename }
    }
  }

  private prefixed(key: string): string {
    return `${this.options.prefix ?? ''}${key}`
  }
}

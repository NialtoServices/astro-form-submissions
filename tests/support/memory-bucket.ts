import type { R2BucketLike } from '#storage/r2.js'

/** One object held by {@link MemoryBucket}, as R2 would store it. */
export interface MemoryObject {
  bytes: Uint8Array<ArrayBuffer>
  httpMetadata: { contentType?: string; contentDisposition?: string }
  customMetadata: Record<string, string>
}

/**
 * An in-memory stand-in for an R2 bucket binding that behaves like one where the toolkit relies on it:
 * it stores real bytes from a `File` or a stream, honours `range` reads while reporting the whole
 * object's `size`, and treats deleting an absent key as a no-op. `objects` is public so a test can seed
 * what a presigned upload would have written, or inspect what the toolkit stored.
 */
export class MemoryBucket implements R2BucketLike {
  readonly objects = new Map<string, MemoryObject>()

  async put(
    key: string,
    value: File | ReadableStream,
    options: {
      httpMetadata: { contentType: string; contentDisposition: string }
      customMetadata: { filename: string }
    }
  ): Promise<void> {
    const bytes = new Uint8Array(await (value instanceof File ? value : new Response(value)).arrayBuffer())

    this.objects.set(key, {
      bytes,
      httpMetadata: { ...options.httpMetadata },
      customMetadata: { ...options.customMetadata }
    })
  }

  async get(key: string, options?: { range: { offset: number; length: number } }) {
    const object = this.objects.get(key)
    if (!object) return null

    const bytes = options
      ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length)
      : object.bytes

    return {
      body: new Response(bytes).body!,
      size: object.bytes.length,
      arrayBuffer: async () => bytes.slice().buffer,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata
    }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  /**
   * Seeds an object as a presigned upload would leave it: bytes, the signed content-type, and the
   * percent-encoded filename metadata.
   */
  seedPresignedUpload(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string, filename: string): void {
    this.objects.set(key, {
      bytes,
      httpMetadata: { contentType },
      customMetadata: { 'filename-uri': encodeURIComponent(filename) }
    })
  }
}

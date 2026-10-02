/** A file the upload route has admitted and is about to grant somewhere to upload to. */
export interface PendingUpload {
  /** The server-generated storage object key (never client-chosen). */
  objectKey: string

  /** The sanitised original filename. */
  filename: string

  /** The declared size in bytes; the stored object is checked against it on submission. */
  size: number

  /** The content-type the object is stored with: an accepted type, or `application/octet-stream`. */
  contentType: string
}

/** Where and how the browser uploads one file: it sends `method` to `url` with exactly `headers`. */
export interface UploadInstruction {
  /** Absolute, or root-relative to the page's own origin. */
  url: string

  /** The HTTP method to upload with. */
  method: 'PUT'

  /** Headers the upload must carry, with exactly these values (some may be signed into the URL). */
  headers: Record<string, string>
}

/**
 * Grants an upload destination for an admitted file. Swappable so the same route can presign straight
 * to object storage in production ({@link R2PresignedUploadTarget}) and upload through the site itself
 * where no S3 endpoint exists, such as local development under Miniflare ({@link WorkerUploadTarget}).
 */
export interface UploadTarget {
  /**
   * Prepares an upload instruction for one file.
   *
   * @param upload - The admitted file.
   * @returns The instruction the browser follows.
   */
  prepare(upload: PendingUpload): Promise<UploadInstruction>
}

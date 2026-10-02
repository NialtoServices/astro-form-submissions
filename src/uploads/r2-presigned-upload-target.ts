import { assertPositiveNumberOption } from '#numeric-options.js'
import { presignURL } from '#uploads/sigv4.js'
import type { PendingUpload, UploadInstruction, UploadTarget } from '#uploads/upload-target.js'

/**
 * Default presigned URL lifetime — one hour, matching the upload route's default receipt lifetime. Every
 * URL is granted at once but the files upload one after another, so on a slow uplink the last one starts
 * long after the first; a URL shorter-lived than the receipt would expire first. The URL is bound to one
 * size and one write, so the longer window grants nothing more.
 */
const DEFAULT_EXPIRES_IN_SECONDS = 60 * 60

/** Options for constructing an {@link R2PresignedUploadTarget}. */
export interface R2PresignedUploadTargetOptions {
  /** The Cloudflare account id the bucket belongs to. */
  accountId: string

  /** The bucket name (the binding's `bucket_name`, not the binding). */
  bucket: string

  /** An R2 API token's access key id, scoped to Object Read & Write on this bucket. */
  accessKeyId: string

  /** That token's secret access key. */
  secretAccessKey: string

  /**
   * Key prefix applied to every object, matching the {@link R2Storage} that reads them back (e.g.
   * `uploads/`), so one lifecycle rule covers both upload paths.
   */
  prefix?: string

  /** Presigned URL lifetime in seconds. Default one hour; keep it no shorter than the receipt lifetime. */
  expiresInSeconds?: number

  /**
   * The S3 API endpoint. Default `https://<accountId>.r2.cloudflarestorage.com`; a bucket under a
   * jurisdiction uses its own (e.g. `https://<accountId>.eu.r2.cloudflarestorage.com`).
   */
  endpoint?: string | URL
}

/**
 * An {@link UploadTarget} that presigns a PUT straight to an R2 bucket through its S3-compatible API,
 * so file bytes never pass through the Worker. The URL is bound to the object key and expires; its
 * content-type, content-length and filename metadata headers are signed, so the upload must carry exactly
 * the type, size and name the route admitted. It is also single-write (`If-None-Match: *`), so an object
 * can't be replaced once stored.
 *
 * The browser uploads cross-origin, so the bucket needs a CORS rule allowing `PUT` from the site's
 * origins with the `Content-Type`, `If-None-Match` and `x-amz-meta-filename-uri` headers.
 */
export class R2PresignedUploadTarget implements UploadTarget {
  private readonly endpoint: URL

  // MARK: - Object Lifecycle

  /**
   * Creates a presigning upload target.
   *
   * @param options - The bucket, its credential, and optional prefix, lifetime and endpoint.
   */
  constructor(private readonly options: R2PresignedUploadTargetOptions) {
    for (const key of ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey'] as const) {
      if (typeof options[key] !== 'string' || options[key] === '') {
        throw new Error(`R2PresignedUploadTarget needs a non-empty \`${key}\`.`)
      }
    }

    assertPositiveNumberOption('R2PresignedUploadTarget `expiresInSeconds`', options.expiresInSeconds, {
      integer: true,
      maximum: 604_800
    })

    this.endpoint = new URL(options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`)
  }

  // MARK: - UploadTarget

  async prepare(upload: PendingUpload): Promise<UploadInstruction> {
    const objectURL = new URL(this.endpoint)
    objectURL.pathname = `/${this.options.bucket}/${this.options.prefix ?? ''}${upload.objectKey}`

    // Header values must be ASCII, so the filename travels percent-encoded; R2Storage decodes it on download.
    // `If-None-Match: *` makes the URL single-write, so an object can't be replaced after it was verified.
    const headers = {
      'Content-Type': upload.contentType,
      'If-None-Match': '*',
      'x-amz-meta-filename-uri': encodeURIComponent(upload.filename)
    }

    // The browser sets Content-Length itself and refuses a script-set one, so it is signed but not
    // returned: R2 then refuses any body whose length differs from the admitted size.
    const url = await presignURL({
      method: 'PUT',
      url: objectURL,
      headers: { ...headers, 'Content-Length': String(upload.size) },
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      region: 'auto',
      service: 's3',
      expiresInSeconds: this.options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS
    })

    return { url: url.toString(), method: 'PUT', headers }
  }
}

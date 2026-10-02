import { assertPositiveNumberOption } from '#numeric-options.js'
import { assertValidSigningSecret, tokenToPathSegment } from '#tokens.js'
import { signUploadClaims } from '#uploads/upload-claims.js'
import type { PendingUpload, UploadInstruction, UploadTarget } from '#uploads/upload-target.js'

/** Default upload grant lifetime — 15 minutes, matching {@link R2PresignedUploadTarget}. */
const DEFAULT_TTL_SECONDS = 15 * 60

/** Options for constructing a {@link WorkerUploadTarget}. */
export interface WorkerUploadTargetOptions {
  /** The HMAC secret the grant is signed with; the matching {@link createUploadPutRoute} needs the same one. */
  secret: string

  /**
   * The path the site mounts {@link createUploadPutRoute} at, as a `[token].ts` route (e.g.
   * `/api/contact/uploads` for `src/pages/api/contact/uploads/[token].ts`).
   */
  basePath: string

  /** Grant lifetime in seconds. Default 15 minutes. */
  ttlSeconds?: number
}

/**
 * An {@link UploadTarget} that uploads through the site itself: the browser PUTs to
 * {@link createUploadPutRoute}, which streams the body into storage. The URL is root-relative, so it
 * resolves against whichever origin served the page, a local dev server included.
 *
 * For local development under Miniflare (whose bucket has no S3 endpoint to presign against), tests, and
 * as a fallback. Each upload passes through the Worker as its own request, so the edge's request-size
 * limit (100 MB on the Free and Pro plans) bounds each file; files are streamed, never buffered.
 */
export class WorkerUploadTarget implements UploadTarget {
  private readonly basePath: string

  // MARK: - Object Lifecycle

  /**
   * Creates a Worker upload target.
   *
   * @param options - The signing secret, the PUT route's mount path, and an optional grant lifetime.
   */
  constructor(private readonly options: WorkerUploadTargetOptions) {
    assertValidSigningSecret(options.secret)
    assertPositiveNumberOption('WorkerUploadTarget `ttlSeconds`', options.ttlSeconds)

    if (!options.basePath.startsWith('/')) {
      throw new Error('WorkerUploadTarget `basePath` must be root-relative, starting with "/".')
    }

    this.basePath = options.basePath.replace(/\/+$/, '')
  }

  // MARK: - UploadTarget

  async prepare(upload: PendingUpload): Promise<UploadInstruction> {
    const token = await signUploadClaims(
      'put',
      upload,
      this.options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      this.options.secret
    )

    return {
      url: `${this.basePath}/${tokenToPathSegment(token)}/`,
      method: 'PUT',
      headers: {
        'Content-Type': upload.contentType,
        'x-amz-meta-filename-uri': encodeURIComponent(upload.filename)
      }
    }
  }
}

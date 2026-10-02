import { containedReporter, type ErrorReporter } from '#reporting.js'
import type { FileStorage } from '#storage/storage.js'
import { assertValidSigningSecret, tokenFromPathSegment } from '#tokens.js'
import { filenameDigest, verifyUploadClaims } from '#uploads/upload-claims.js'
import type { APIRoute } from 'astro'

/** Configuration for {@link createUploadPutRoute}. */
export interface CreateUploadPutRouteConfig {
  /** Where uploads are written: the same storage the {@link UploadedFiles} enricher reads back. Must implement `putStream`. */
  storage: FileStorage

  /** The HMAC secret the {@link WorkerUploadTarget} signs grants with. */
  secret: string

  /** Route param carrying the grant (from the `[param].ts` filename). Default `token`. */
  tokenParam?: string

  /**
   * Called with a failed write (stage `upload`) before the 502 is returned. Awaited and contained, so a
   * reporter that throws can't change the response. The same contract as the form route's `onError`;
   * default {@link defaultErrorReporter}.
   */
  onError?: ErrorReporter
}

const plain = (body: string, status: number) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

/** The upload's filename from its percent-encoded header, or `undefined` when absent or malformed. */
function headerFilename(request: Request): string | undefined {
  const encoded = request.headers.get('x-amz-meta-filename-uri')
  if (encoded === null) return undefined

  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

/**
 * Builds the `PUT` handler {@link WorkerUploadTarget} points browsers at (e.g.
 * `src/pages/api/contact/uploads/[token].ts`): verify the grant, check the declared length against the
 * admitted size, and stream the body into storage without buffering it.
 *
 * The filename arrives percent-encoded in an `x-amz-meta-filename-uri` header, as on a presigned upload,
 * and must be the one admitted; the grant in the URL carries only its digest, so request logs never
 * record the name.
 *
 * Responses: 200 once stored; 404 for an invalid, expired or wrong-purpose grant (never revealing which);
 * 411 without a `Content-Length`; 413 when it exceeds the admitted size; 400 when it is smaller, or when
 * the filename header is missing or not the admitted name; 502 when the write fails, including a stream
 * whose bytes run short or long of its declared length.
 */
export function createUploadPutRoute(config: CreateUploadPutRouteConfig): APIRoute {
  assertValidSigningSecret(config.secret)

  if (typeof config.storage.putStream !== 'function') {
    throw new Error('createUploadPutRoute needs a storage that implements `putStream` (R2Storage does).')
  }

  const putStream = config.storage.putStream.bind(config.storage)
  const report = containedReporter(config.onError)

  const tokenParam = config.tokenParam ?? 'token'

  return async ({ params, request }) => {
    const upload = await verifyUploadClaims('put', tokenFromPathSegment(params[tokenParam] ?? ''), config.secret)
    if (!upload) return plain('Not found', 404)

    const declaredLength = request.headers.get('content-length')
    if (declaredLength === null || !request.body) return plain('Length required', 411)

    const length = Number(declaredLength)
    if (length > upload.size) return plain('This file is larger than was declared.', 413)
    if (length !== upload.size) return plain('This file is not the size that was declared.', 400)

    const filename = headerFilename(request)
    if (filename === undefined || (await filenameDigest(filename, config.secret)) !== upload.filenameDigest) {
      return plain('This file is not the one that was declared.', 400)
    }

    try {
      await putStream(upload.objectKey, request.body, {
        contentType: upload.contentType,
        filename,
        size: upload.size
      })
    } catch (error) {
      await report(error, 'upload')
      return plain('This file could not be stored. Please try again.', 502)
    }

    return new Response(null, { status: 200 })
  }
}

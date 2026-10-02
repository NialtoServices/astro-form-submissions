import { type FileStorage } from '#storage/storage.js'
import { assertValidSigningSecret, tokenFromPathSegment } from '#tokens.js'
import { verifyUploadClaims } from '#uploads/upload-claims.js'
import { type APIRoute } from 'astro'

/** Configuration for {@link createUploadPutRoute}. */
export interface CreateUploadPutRouteConfig {
  /** Where uploads are written: the same storage the {@link UploadedFiles} enricher reads back. Must implement `putStream`. */
  storage: FileStorage

  /** The HMAC secret the {@link WorkerUploadTarget} signs grants with. */
  secret: string

  /** Route param carrying the grant (from the `[param].ts` filename). Default `token`. */
  tokenParam?: string

  /**
   * Called with a failed write before the 502 is returned. Awaited and contained, so a reporter that
   * throws can't change the response. Default: nothing is reported.
   */
  onError?: (error: unknown) => void | Promise<void>
}

const plain = (body: string, status: number) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

/**
 * Builds the `PUT` handler {@link WorkerUploadTarget} points browsers at (e.g.
 * `src/pages/api/contact/uploads/[token].ts`): verify the grant, check the declared length against the
 * admitted size, and stream the body into storage without buffering it.
 *
 * Responses: 200 once stored; 404 for an invalid, expired or wrong-purpose grant (never revealing which);
 * 411 without a `Content-Length`; 413 when it exceeds the admitted size; 400 when it is smaller; 502 when
 * the write fails, including a stream whose bytes run short or long of its declared length.
 */
export function createUploadPutRoute(config: CreateUploadPutRouteConfig): APIRoute {
  assertValidSigningSecret(config.secret)

  if (typeof config.storage.putStream !== 'function') {
    throw new Error('createUploadPutRoute needs a storage that implements `putStream` (R2Storage does).')
  }

  const putStream = config.storage.putStream.bind(config.storage)

  const tokenParam = config.tokenParam ?? 'token'

  return async ({ params, request }) => {
    const upload = await verifyUploadClaims('put', tokenFromPathSegment(params[tokenParam] ?? ''), config.secret)
    if (!upload) return plain('Not found', 404)

    const declaredLength = request.headers.get('content-length')
    if (declaredLength === null || !request.body) return plain('Length required', 411)

    const length = Number(declaredLength)
    if (length > upload.size) return plain('This file is larger than was declared.', 413)
    if (length !== upload.size) return plain('This file is not the size that was declared.', 400)

    try {
      await putStream(upload.objectKey, request.body, {
        contentType: upload.contentType,
        filename: upload.filename,
        size: upload.size
      })
    } catch (error) {
      try {
        await config.onError?.(error)
      } catch {
        // Nowhere left to report a broken reporter; the sender still gets the 502.
      }

      return plain('This file could not be stored. Please try again.', 502)
    }

    return new Response(null, { status: 200 })
  }
}

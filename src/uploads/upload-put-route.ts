import type { VerdictDetails } from '#pipeline.js'
import { containedReporter, withReportingBudget, type ErrorReporter } from '#reporting.js'
import { ObjectExistsError } from '#storage/object-exists-error.js'
import type { FileStorage } from '#storage/storage.js'
import { SubmissionVerdictError } from '#submission-verdict-error.js'
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
   * Called (stage `upload`) with a failed write before the 502 is returned, and with each refused upload as a
   * {@link SubmissionVerdictError}. Contained, so a reporter that throws or stalls can't change the response,
   * and a request waits for its calls for at most 5 seconds in all. The same contract as the form route's
   * `onError`; default {@link defaultErrorReporter}.
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
 * Every refusal is reported to `onError` with a code (see the README's Logs section). Responses: 200 once
 * stored; 404 for an invalid, expired or wrong-purpose grant (never revealing which);
 * 411 without a `Content-Length`; 413 when it exceeds the admitted size; 400 when it is smaller, or when
 * the filename header is missing or not the admitted name; 409 when the grant has already stored its file,
 * which can't be replaced; 502 when the write fails, including a stream whose bytes run short or long of its
 * declared length.
 */
export function createUploadPutRoute(config: CreateUploadPutRouteConfig): APIRoute {
  assertValidSigningSecret(config.secret)

  if (typeof config.storage.putStream !== 'function') {
    throw new Error('createUploadPutRoute needs a storage that implements `putStream` (R2Storage does).')
  }

  const putStream = config.storage.putStream.bind(config.storage)
  const reporter = containedReporter(config.onError)

  const tokenParam = config.tokenParam ?? 'token'

  return async ({ params, request }) => {
    const report = withReportingBudget(reporter)

    // Every refusal is reported: without it, an expired grant on a slow connection leaves no trace in the log.
    const refuse = async (body: string, status: number, code: string, details?: VerdictDetails) => {
      await report(new SubmissionVerdictError('reject', code, details), 'upload')
      return plain(body, status)
    }

    const upload = await verifyUploadClaims('put', tokenFromPathSegment(params[tokenParam] ?? ''), config.secret)
    if (!upload) return refuse('Not found', 404, 'upload-put.grant-invalid')

    const declaredLength = request.headers.get('content-length')
    if (declaredLength === null || !request.body) return refuse('Length required', 411, 'upload-put.length-missing')

    const length = Number(declaredLength)
    if (length > upload.size) {
      return refuse('This file is larger than was declared.', 413, 'upload-put.too-large', {
        declared: length,
        admitted: upload.size
      })
    }

    if (length !== upload.size) {
      return refuse('This file is not the size that was declared.', 400, 'upload-put.size-mismatch', {
        declared: length,
        admitted: upload.size
      })
    }

    const filename = headerFilename(request)
    if (filename === undefined || (await filenameDigest(filename, config.secret)) !== upload.filenameDigest) {
      return refuse('This file is not the one that was declared.', 400, 'upload-put.filename-mismatch')
    }

    try {
      await putStream(upload.objectKey, request.body, {
        contentType: upload.contentType,
        filename,
        size: upload.size
      })
    } catch (error) {
      if (error instanceof ObjectExistsError) {
        return refuse('This file has already been uploaded.', 409, 'upload-put.already-stored')
      }

      await report(error, 'upload')
      return plain('This file could not be stored. Please try again.', 502)
    }

    return new Response(null, { status: 200 })
  }
}

import { type Enricher, type EnrichmentContext, type EnrichmentResult } from '#enrichers/enricher.js'
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_TOTAL_BYTES,
  FileUploads,
  type FileLink
} from '#enrichers/file-uploads.js'
import { formError, type FormError } from '#errors.js'
import { type FilePayload } from '#files/signing.js'
import { ALL_TYPES, HEADER_BYTES, sniffBytes, type FileMatcher } from '#files/sniff.js'
import { type FormSubmission } from '#pipeline.js'
import { type FileStorage, type PeekedObject } from '#storage/storage.js'
import { assertValidSigningSecret } from '#tokens.js'
import { verifyUploadClaims } from '#uploads/upload-claims.js'
import { type PendingUpload } from '#uploads/upload-target.js'

/** The content-type an upload carries when its declared type wasn't one the form accepts. */
const OPAQUE_CONTENT_TYPE = 'application/octet-stream'

/** Options for constructing an {@link UploadedFiles} enricher. */
export interface UploadedFilesOptions<E extends FormSubmission = FormSubmission, K extends string = 'files'> {
  /** The storage the uploads landed in (e.g. an {@link R2Storage}). Must implement `peek`. */
  storage: FileStorage

  /** The HMAC secret the {@link createUploadRoute} signed receipts with. */
  secret: string

  /** Form field carrying the receipts, one value per file. Default `upload`. */
  field?: string

  /** The key the resolved `FileLink[]` is exposed under on `context.resources`. Default `files`. */
  attachTo?: K

  /** Maximum number of files per submission. Default {@link DEFAULT_MAX_FILES}. */
  maxFiles?: number

  /** Maximum size of a single file, in bytes. Default {@link DEFAULT_MAX_FILE_BYTES}. */
  maxFileBytes?: number

  /** Maximum combined size of all files, in bytes. Default {@link DEFAULT_MAX_TOTAL_BYTES}. */
  maxTotalBytes?: number

  /** Permitted content-type matchers, checked against the stored bytes. Default {@link ALL_TYPES}. */
  accept?: FileMatcher[]

  /** Turns a stored object into a download URL (e.g. {@link signedLink}). */
  link: (stored: FilePayload, context: EnrichmentContext<E>) => Promise<string>
}

/**
 * The enricher for files uploaded straight to storage before the submission (see
 * {@link createUploadRoute}). The submission carries a signed receipt per file instead of its bytes; this
 * verifies each receipt, confirms the stored object exists at the admitted size, sniffs its leading bytes
 * against `accept`, and exposes signed download links under `context.resources[attachTo]` — with the same
 * rollback as {@link FileUploads}: the objects are kept once a resource-exposing delivery succeeds, and
 * deleted otherwise.
 *
 * A refused submission deletes every object it referenced, so a retry uploads afresh. Refusals:
 * `uploadMissing` (an invalid or expired receipt, a missing object, or one whose size differs from its
 * receipt), `tooManyFiles` / `fileTooLarge` (the limits, re-checked here), and `fileType` (the bytes match
 * nothing accepted, or contradict the type the object was stored with).
 */
export class UploadedFiles<
  E extends FormSubmission = FormSubmission,
  const K extends string = 'files'
> implements Enricher<E, Record<K, FileLink[]>> {
  /** Errors this enricher rejects with, beside {@link FileUploads.errors}. Override the copy per-site via `errors[key]`. */
  static readonly errors = {
    uploadMissing: formError('uploadMissing', 400, "One of your files didn't finish uploading. Please try again.")
  }

  private readonly peek: (key: string, length: number) => Promise<PeekedObject | null>

  // MARK: - Object Lifecycle

  /**
   * Creates an enricher for directly uploaded files.
   *
   * @param options - Storage, receipt secret, field, limits, accepted types, and the link resolver / attach key.
   */
  constructor(private readonly options: UploadedFilesOptions<E, K>) {
    assertValidSigningSecret(options.secret)

    if (typeof options.storage.peek !== 'function') {
      throw new Error('UploadedFiles needs a storage that implements `peek` (R2Storage does).')
    }

    this.peek = options.storage.peek.bind(options.storage)
  }

  // MARK: - Enricher API

  async enrich(submission: E, context: EnrichmentContext<E>): Promise<EnrichmentResult<Record<K, FileLink[]>>> {
    const field = this.options.field ?? 'upload'
    const attachTo = this.options.attachTo ?? 'files'

    const receipts = context.data
      .getAll(field)
      .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    if (receipts.length === 0) return {}

    const verified = await Promise.all(
      receipts.map((receipt) => verifyUploadClaims('receipt', receipt, this.options.secret))
    )

    // Duplicate receipts name one object; it is linked once.
    const uploads = new Map<string, PendingUpload>()
    for (const upload of verified) {
      if (upload && !uploads.has(upload.objectKey)) uploads.set(upload.objectKey, upload)
    }

    const keys = [...uploads.keys()]
    const refuse = async (error: FormError) => {
      await this.delete(keys, context)
      return { reject: error }
    }

    if (verified.includes(null)) return refuse(UploadedFiles.errors.uploadMissing)

    const limitError = this.limitError([...uploads.values()])
    if (limitError) return refuse(limitError)

    try {
      const links: FileLink[] = []
      for (const upload of uploads.values()) {
        const object = await this.peek(upload.objectKey, HEADER_BYTES)
        if (!object || object.size !== upload.size) return refuse(UploadedFiles.errors.uploadMissing)

        const contentType = sniffBytes(object.header, this.options.accept ?? ALL_TYPES)
        const storedType = object.contentType ?? OPAQUE_CONTENT_TYPE
        if (!contentType || (storedType !== OPAQUE_CONTENT_TYPE && storedType !== contentType)) {
          return refuse(FileUploads.errors.fileType)
        }

        const url = await this.options.link(
          { objectKey: upload.objectKey, filename: upload.filename, contentType },
          context
        )
        links.push({ name: upload.filename, url, size: upload.size })
      }

      // A computed-key object widens to `{ [x: string]: FileLink[] }`, so the assertion is the one
      // spot TS can't express the `Record<K, …>` literal; the key is config-owned, never user input.
      const provide = { [attachTo]: links } as Record<K, FileLink[]>
      return { provide, rollback: () => this.delete(keys, context) }
    } catch (error) {
      // Clean up and fail closed. No rollback is returned: the objects are already gone, so the route
      // must not delete them a second time.
      context.report?.(error)
      return refuse(FileUploads.errors.uploadFailed)
    }
  }

  // MARK: - Validation

  private limitError(uploads: PendingUpload[]): FormError | undefined {
    const maxFiles = this.options.maxFiles ?? DEFAULT_MAX_FILES
    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    const maxTotalBytes = this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES

    if (uploads.length > maxFiles) return FileUploads.errors.tooManyFiles

    let totalBytes = 0
    for (const upload of uploads) {
      if (upload.size > maxFileBytes) return FileUploads.errors.fileTooLarge

      totalBytes += upload.size
      if (totalBytes > maxTotalBytes) return FileUploads.errors.fileTooLarge
    }

    return undefined
  }

  // MARK: - Storage

  private async delete(keys: string[], context: EnrichmentContext<E>): Promise<void> {
    const results = await Promise.allSettled(keys.map((key) => this.options.storage.delete(key)))
    const failed = keys.filter((_key, index) => results[index]?.status === 'rejected')
    if (failed.length > 0) {
      // Report the keys we couldn't delete so an operator can reconcile them — the objects may
      // hold personal files, and a silent failure would leave no trail.
      context.report?.(new Error(`Failed to delete ${failed.length} uploaded object(s): ${failed.join(', ')}`))
    }
  }
}

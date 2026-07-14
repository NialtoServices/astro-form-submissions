import { type Enricher, type EnrichmentContext, type EnrichmentResult } from '#enrichers/enricher.js'
import { formError } from '#errors.js'
import { type FilePayload } from '#files/signing.js'
import { ALL_TYPES, sniffType, type FileMatcher } from '#files/sniff.js'
import { type FormSubmission } from '#pipeline.js'
import { type FileStorage } from '#storage/storage.js'

const MB = 1024 * 1024

/** Default maximum number of files per submission. */
export const DEFAULT_MAX_FILES = 5

/** Default maximum size of a single file, in bytes (10 MB). */
export const DEFAULT_MAX_FILE_BYTES = 10 * MB

/** Default maximum combined size of all files, in bytes (50 MB). */
export const DEFAULT_MAX_TOTAL_BYTES = 50 * MB

/** A stored file's display name, download URL, and size, exposed to the dispatchers. */
export interface FileLink {
  /** The file's display name (its original filename). */
  name: string

  /** The signed download URL for the stored file. */
  url: string

  /** The file's size in bytes. `FileUploads` always sets it; optional so a hand-built link may omit it. */
  size?: number
}

/** Options for constructing a {@link FileUploads} enricher. */
export interface FileUploadsOptions<E extends FormSubmission = FormSubmission, K extends string = 'files'> {
  /** Where validated files are stored (e.g. an {@link R2Storage}). */
  storage: FileStorage

  /** Form field carrying the file inputs. Default `file`. */
  field?: string

  /**
   * The key the resolved `FileLink[]` is exposed under on `context.resources` for the dispatchers
   * (e.g. `attachTo: 'files'` → `context.resources.files`). Default `files`. The email templates'
   * `attachments` option names the same key, and the route checks that a dispatcher reading a resource
   * key has an enricher providing it.
   */
  attachTo?: K

  /** Maximum number of files per submission. Default {@link DEFAULT_MAX_FILES}. */
  maxFiles?: number

  /** Maximum size of a single file, in bytes. Default {@link DEFAULT_MAX_FILE_BYTES}. */
  maxFileBytes?: number

  /** Maximum combined size of all files, in bytes. Default {@link DEFAULT_MAX_TOTAL_BYTES}. */
  maxTotalBytes?: number

  /** Permitted content-type matchers, checked by magic bytes (never the client MIME). Default {@link ALL_TYPES}. */
  accept?: FileMatcher[]

  /** Turns a stored object into a download URL (e.g. {@link signedLink}). */
  link: (stored: FilePayload, context: EnrichmentContext<E>) => Promise<string>
}

/**
 * An enricher that validates uploaded files (count, size, magic-byte type), moves them to storage,
 * and exposes the resulting download links to the dispatchers under `context.resources[attachTo]` —
 * with rollback keyed on delivery: the route **keeps** the stored objects when a resource-exposing
 * delivery succeeds (deleting them would dangle a recipient's links, even if a required sibling
 * dispatcher later fails), and **deletes** them otherwise — a later enricher rejects, every delivery
 * fails, or only non-exposing deliveries succeed.
 *
 * Validation failures are clean client refusals (`tooManyFiles` / `fileTooLarge` / `fileType`). A
 * storage failure fails the request with `send` (502) — the same key the email dispatcher uses, so
 * a site's `errors.send` override covers both.
 */
export class FileUploads<
  E extends FormSubmission = FormSubmission,
  const K extends string = 'files'
> implements Enricher<E, Record<K, FileLink[]>> {
  /** Errors this enricher rejects with. Override the copy per-site via `errors[key]`. */
  static readonly errors = {
    tooManyFiles: formError('tooManyFiles', 400, 'Please attach fewer files.'),
    fileTooLarge: formError('fileTooLarge', 400, 'A file is too large. Please attach smaller files.'),
    fileType: formError('fileType', 400, 'That file type is not accepted.'),

    // Reuses the `send` key so a site's `errors.send` override covers upload and mail failure alike.
    uploadFailed: formError('send', 502, 'Could not send your message right now. Please try again or call us directly.')
  }

  // MARK: - Object Lifecycle

  /**
   * Creates a file-upload enricher.
   *
   * @param options - Storage, field, limits, accepted types, and the link resolver / attach key.
   */
  constructor(private readonly options: FileUploadsOptions<E, K>) {}

  // MARK: - Enricher API

  async enrich(submission: E, context: EnrichmentContext<E>): Promise<EnrichmentResult<Record<K, FileLink[]>>> {
    const field = this.options.field ?? 'file'
    const attachTo = this.options.attachTo ?? 'files'
    const maxFiles = this.options.maxFiles ?? DEFAULT_MAX_FILES
    const maxFileBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    const maxTotalBytes = this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    const accept = this.options.accept ?? ALL_TYPES

    // A file input left empty still submits a zero-byte part — drop those before counting.
    const files = context.data.getAll(field).filter((entry): entry is File => entry instanceof File && entry.size > 0)
    if (files.length === 0) return {}

    if (files.length > maxFiles) return { reject: FileUploads.errors.tooManyFiles }

    const validated: { file: File; contentType: string }[] = []
    let totalBytes = 0
    for (const file of files) {
      if (file.size > maxFileBytes) return { reject: FileUploads.errors.fileTooLarge }

      totalBytes += file.size
      if (totalBytes > maxTotalBytes) return { reject: FileUploads.errors.fileTooLarge }

      const contentType = await sniffType(file, accept)
      if (!contentType) return { reject: FileUploads.errors.fileType }

      validated.push({ file, contentType })
    }

    // A `put` can commit the object yet still throw (a lost acknowledgement), so a key is known to
    // rollback once it enters `storedKeys` — deleting a never-written key is a safe no-op per the
    // FileStorage contract.
    const storedKeys: string[] = []
    const links: FileLink[] = []
    try {
      for (const { file, contentType } of validated) {
        const objectKey = crypto.randomUUID()
        const filename = (file.name || 'upload').replace(/[\r\n"]/g, '')
        storedKeys.push(objectKey)
        await this.options.storage.put(objectKey, file, { contentType, filename })

        const url = await this.options.link({ objectKey, filename, contentType }, context)
        links.push({ name: filename, url, size: file.size })
      }

      // A computed-key object widens to `{ [x: string]: FileLink[] }`, so the assertion is the one
      // spot TS can't express the `Record<K, …>` literal; the key is config-owned, never user input.
      const provide = { [attachTo]: links } as Record<K, FileLink[]>
      return { provide, rollback: () => this.rollback(storedKeys, context) }
    } catch (error) {
      // Clean up this enricher's own partial work, then fail closed. No rollback is returned — the
      // objects are already gone, so the route must not delete them a second time.
      context.report?.(error)
      await this.rollback(storedKeys, context)
      return { reject: FileUploads.errors.uploadFailed }
    }
  }

  // MARK: - Storage

  private async rollback(keys: string[], context: EnrichmentContext<E>): Promise<void> {
    const results = await Promise.allSettled(keys.map((key) => this.options.storage.delete(key)))
    const failed = keys.filter((_key, index) => results[index]?.status === 'rejected')
    if (failed.length > 0) {
      // Report the keys we couldn't delete so an operator can reconcile them — the objects may
      // hold personal files, and a silent failure would leave no trail.
      context.report?.(new Error(`Failed to delete ${failed.length} uploaded object(s): ${failed.join(', ')}`))
    }
  }
}

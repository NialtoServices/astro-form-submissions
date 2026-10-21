import type { Enricher, EnrichmentContext, EnrichmentResult } from '#enrichers/enricher.js'
import { checkFiles, type CheckedFile } from '#enrichers/file-checks.js'
import { DEFAULT_MAX_FILES } from '#enrichers/file-uploads.js'
import { FileRefusals } from '#files/file-refusals.js'
import { ALL_TYPES, type FileMatcher } from '#files/sniff.js'
import { assertFileLimitOptions } from '#numeric-options.js'
import type { FormSubmission } from '#pipeline.js'

const MB = 1024 * 1024

/** Default maximum combined size of the attached files, in bytes (5 MB), which an email can carry. */
export const DEFAULT_ATTACHMENT_TOTAL_BYTES = 5 * MB

/** A checked file held in memory for a dispatcher to send along, such as an email attachment. */
export interface AttachedFile {
  /** The cleaned filename, ending in the extension of the type the file's bytes matched. */
  readonly name: string

  /** The content type the file's bytes matched, never the client's claim. */
  readonly contentType: string

  /** The file's size in bytes. */
  readonly size: number

  /** The file's bytes. The file is read on the first call, and every call returns that same array. */
  bytes(): Promise<Uint8Array>
}

/** Options for constructing a {@link FileAttachments} enricher. */
export interface FileAttachmentsOptions<K extends string = 'files'> {
  /** Form field carrying the file inputs. Default `file`. */
  field?: string

  /**
   * Permitted content-type matchers, checked by magic bytes (never the client MIME), reading further ranges of
   * the file for a matcher that asks. Default {@link ALL_TYPES}.
   */
  accept?: readonly FileMatcher[]

  /** The key the {@link AttachedFile} list is exposed under on `context.resources`. Default `files`. */
  attachTo?: K

  /** Maximum number of files per submission. Default {@link DEFAULT_MAX_FILES}. */
  maxFiles?: number

  /** Maximum size of a single file, in bytes. Default: no limit beyond `maxTotalBytes`. */
  maxFileBytes?: number

  /** Maximum combined size of all files, in bytes. Default {@link DEFAULT_ATTACHMENT_TOTAL_BYTES}. */
  maxTotalBytes?: number

  /** Whether the field must carry a file. An empty field is refused with `fileRequired`. Default `false`. */
  required?: boolean
}

/** A checked file whose bytes are read when first asked for. */
class HeldFile implements AttachedFile {
  readonly name: string
  readonly contentType: string
  readonly size: number

  private pendingBytes: Promise<Uint8Array> | undefined

  constructor(
    private readonly file: File,
    checked: CheckedFile
  ) {
    this.name = checked.name
    this.contentType = checked.contentType
    this.size = file.size
  }

  bytes(): Promise<Uint8Array> {
    this.pendingBytes ??= this.file.arrayBuffer().then((buffer) => new Uint8Array(buffer))
    return this.pendingBytes
  }
}

/**
 * An enricher for files that travel with the submission rather than being stored: it checks the files the
 * form posted (count, size, magic-byte type, name), exactly as {@link FileUploads} does, and holds them in
 * memory under `context.resources[attachTo]` for a dispatcher to send along, such as an email carrying them.
 *
 * Nothing is stored, so there is nothing to roll back and no download link to keep alive. The files live in
 * the request's memory, which is why the total defaults to {@link DEFAULT_ATTACHMENT_TOTAL_BYTES} rather than
 * `FileUploads`' 50 MB.
 *
 * Refusals are the same as `FileUploads`' (`tooManyFiles` / `fileTooLarge` / `filesTooLarge` / `fileType` /
 * `fileRequired`), each naming the file field and carrying its limits as copy placeholders. The reason codes
 * are `file-attachments.*`, and `too-large` applies only when `maxFileBytes` is given.
 */
export class FileAttachments<
  E extends FormSubmission = FormSubmission,
  const K extends string = 'files'
> implements Enricher<E, Record<K, AttachedFile[]>> {
  /** Errors this enricher rejects with. Override the copy per-site via `errors[key]`. */
  static readonly errors = FileRefusals.errors

  // MARK: - Object Lifecycle

  /**
   * Creates a file-attachments enricher.
   *
   * @param options - Field, limits, accepted types and attach key.
   */
  constructor(private readonly options: FileAttachmentsOptions<K> = {}) {
    assertFileLimitOptions('FileAttachments', options)
  }

  // MARK: - Limits

  /** The most file bytes one submission may carry, which the form route adds to the body it will read. */
  get maxTotalBytes(): number {
    return this.options.maxTotalBytes ?? DEFAULT_ATTACHMENT_TOTAL_BYTES
  }

  // MARK: - Enricher API

  async enrich(_submission: E, context: EnrichmentContext<E>): Promise<EnrichmentResult<Record<K, AttachedFile[]>>> {
    const attachTo = this.options.attachTo ?? 'files'

    const checks = await checkFiles(
      context.data,
      {
        field: this.options.field ?? 'file',
        maxFiles: this.options.maxFiles ?? DEFAULT_MAX_FILES,
        maxFileBytes: this.options.maxFileBytes,
        maxTotalBytes: this.maxTotalBytes,
        accept: this.options.accept ?? ALL_TYPES,
        required: this.options.required ?? false
      },
      'file-attachments'
    )
    if ('reject' in checks) return checks

    const attached: AttachedFile[] = checks.files.map((checked) => new HeldFile(checked.file, checked))

    // The key is provided even when empty, so a dispatcher can tell "no files posted" from "no enricher provides
    // this key". A computed-key object widens to `{ [x: string]: AttachedFile[] }`, so the assertion is the one spot TS
    // can't express the `Record<K, …>` literal; the key is config-owned, never user input.
    const provide = { [attachTo]: attached } as Record<K, AttachedFile[]>
    return { provide }
  }
}

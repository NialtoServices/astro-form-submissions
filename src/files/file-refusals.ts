import { FILE_COPY } from '#client/file-copy.js'
import { formatFileSize } from '#client/file-size.js'
import { formError, type FormError } from '#errors.js'
import { describeAcceptedTypes } from '#files/accepted-types.js'
import type { FileMatcher } from '#files/sniff.js'

/** What {@link FileRefusals} needs to know about a file field. */
export interface FileRefusalRules {
  /** The name of the file input, which every refusal is reported against. */
  field: string

  /** Maximum number of files. */
  maxFiles: number

  /** Maximum size of a single file, in bytes. */
  maxFileBytes: number

  /** Maximum combined size of all files, in bytes. */
  maxTotalBytes: number

  /** The accepted types, whose labels the type refusal lists. */
  accept: readonly FileMatcher[]
}

/**
 * The refusals a file field can raise, each naming the field and carrying the field's limits as copy
 * placeholders (`{maxFiles}`, `{maxFileSize}`, `{maxTotalSize}`, `{types}`), so a refusal tells the person
 * which input to fix and by how much, and a site's own copy can use the same tokens.
 *
 * Shared by every route that applies file limits, so a refusal reads the same whichever one raised it.
 */
export class FileRefusals {
  /** The default error for each refusal, whose copy holds the unfilled `{name}` tokens. */
  static readonly errors = {
    tooManyFiles: formError('tooManyFiles', 400, FILE_COPY.tooManyFiles),
    fileTooLarge: formError('fileTooLarge', 400, FILE_COPY.fileTooLarge),
    filesTooLarge: formError('filesTooLarge', 400, FILE_COPY.filesTooLarge),
    fileType: formError('fileType', 400, FILE_COPY.fileType),
    fileRequired: formError('fileRequired', 400, FILE_COPY.fileRequired)
  }

  private readonly field: string
  private readonly maxFiles: number
  private readonly placeholders: Readonly<Record<string, string>>

  // MARK: - Object Lifecycle

  /**
   * Creates the refusals for one file field.
   *
   * @param rules - The field's name and limits.
   */
  constructor(rules: FileRefusalRules) {
    this.field = rules.field
    this.maxFiles = rules.maxFiles
    this.placeholders = {
      maxFiles: String(rules.maxFiles),
      maxFileSize: formatFileSize(rules.maxFileBytes),
      maxTotalSize: formatFileSize(rules.maxTotalBytes),
      types: describeAcceptedTypes(rules.accept)
    }
  }

  // MARK: - Refusals

  /** More files than the field allows. Reads "only one file" when the limit is one. */
  tooManyFiles(): FormError {
    const message = this.maxFiles === 1 ? FILE_COPY.tooManyFilesSingle : FILE_COPY.tooManyFiles
    return this.named(formError('tooManyFiles', 400, message))
  }

  /** One file over the per-file limit. */
  fileTooLarge(): FormError {
    return this.named(FileRefusals.errors.fileTooLarge)
  }

  /** The files together over the total limit. */
  filesTooLarge(): FormError {
    return this.named(FileRefusals.errors.filesTooLarge)
  }

  /** A file whose type is not accepted. */
  fileType(): FormError {
    return this.named(FileRefusals.errors.fileType)
  }

  /** A required field left empty. */
  fileRequired(): FormError {
    return this.named(FileRefusals.errors.fileRequired)
  }

  // MARK: - Naming

  private named(error: FormError): FormError {
    return { ...error, field: this.field, placeholders: this.placeholders }
  }
}

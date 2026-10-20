import type { FormError } from '#errors.js'
import { FileRefusals } from '#files/file-refusals.js'
import { storedFilename } from '#files/filename.js'
import { extensionsFor, sniffType, type FileMatcher } from '#files/sniff.js'
import type { VerdictReason } from '#pipeline.js'

/** The limits and types one submission's files are checked against. */
export interface FileCheckRules {
  /** The form field carrying the files, which every refusal is reported against. */
  field: string

  /** Maximum number of files. */
  maxFiles: number

  /** Maximum size of a single file, in bytes. Omit it to apply no per-file limit. */
  maxFileBytes?: number

  /** Maximum combined size of all files, in bytes. */
  maxTotalBytes: number

  /** The accepted types, checked against the files' bytes. */
  accept: readonly FileMatcher[]

  /** Whether an empty field is refused. */
  required: boolean
}

/** A file that passed every check, with the content type its bytes matched and its cleaned name. */
export interface CheckedFile {
  /** The file as the browser sent it. */
  file: File

  /** The content type the file's bytes matched, never the client's claim. */
  contentType: string

  /** The cleaned filename, ending in the matched type's extension. */
  name: string
}

/** A refusal for the route: the error the sender sees, with the reason code and details for the logs. */
export type FileRefusal = { reject: FormError } & VerdictReason

/** The reason-code namespaces of the enrichers that read files from the form data. */
export type FileCheckCodePrefix = 'file-uploads' | 'file-attachments'

/**
 * Reads a file field from the form data and checks it: a file input left empty still submits a zero-byte
 * part, so those are dropped first, then the count, each file's size, the total and each file's type (by its
 * bytes) are checked in that order, stopping at the first refusal. Shared by every enricher that takes files
 * from the multipart body, so the same rules refuse the same files with the same copy and reason codes.
 *
 * @param data - The submission's form data.
 * @param rules - The field's limits and accepted types.
 * @param codePrefix - The namespace of the reason codes, such as `file-uploads` for `file-uploads.too-many`.
 * @returns The checked files (none when the field is empty and not required), or the refusal.
 */
export async function checkFiles(
  data: FormData,
  rules: FileCheckRules,
  codePrefix: FileCheckCodePrefix
): Promise<{ files: CheckedFile[] } | FileRefusal> {
  const refusals = new FileRefusals({
    field: rules.field,
    maxFiles: rules.maxFiles,
    maxFileBytes: rules.maxFileBytes ?? rules.maxTotalBytes,
    maxTotalBytes: rules.maxTotalBytes,
    accept: rules.accept
  })

  const files = data.getAll(rules.field).filter((entry): entry is File => entry instanceof File && entry.size > 0)
  if (files.length === 0) {
    return rules.required ? { reject: refusals.fileRequired(), code: `${codePrefix}.required` } : { files: [] }
  }

  if (files.length > rules.maxFiles) {
    return {
      reject: refusals.tooManyFiles(),
      code: `${codePrefix}.too-many`,
      details: { count: files.length, limit: rules.maxFiles }
    }
  }

  const checked: CheckedFile[] = []
  let totalBytes = 0
  for (const file of files) {
    if (rules.maxFileBytes !== undefined && file.size > rules.maxFileBytes) {
      return {
        reject: refusals.fileTooLarge(),
        code: `${codePrefix}.too-large`,
        details: { size: file.size, limit: rules.maxFileBytes }
      }
    }

    totalBytes += file.size
    if (totalBytes > rules.maxTotalBytes) {
      return {
        reject: refusals.filesTooLarge(),
        code: `${codePrefix}.total-too-large`,
        details: { total: totalBytes, limit: rules.maxTotalBytes }
      }
    }

    const contentType = await sniffType(file, rules.accept)
    if (!contentType) return { reject: refusals.fileType(), code: `${codePrefix}.type-not-accepted` }

    checked.push({ file, contentType, name: storedFilename(file.name, extensionsFor(contentType, rules.accept)) })
  }

  return { files: checked }
}

// MARK: - Types

/** What a file input allows, read from the attributes `uploadInputAttributes` writes. */
export interface FileLimits {
  /** The most files the field takes; one for an input without `multiple`. */
  maxFiles: number

  /** The most bytes in one file; `Infinity` when the input names no limit. */
  maxFileBytes: number

  /** The most bytes in all the files together; `Infinity` when the input names no limit. */
  maxTotalBytes: number

  /** The input's `accept` tokens, lower-cased: content types, `type/*` wildcards and `.ext` extensions. */
  accept: readonly string[]
}

/** Why the browser holds a chosen file back, named as the server's error copy keys are. */
export type FileProblem = 'tooManyFiles' | 'fileTooLarge' | 'filesTooLarge' | 'fileType'

// MARK: - Limits

/** A positive limit from an attribute, or `Infinity` when the attribute is absent or not a positive number. */
function readLimit(inputElement: HTMLInputElement, attribute: string): number {
  const limit = Number(inputElement.getAttribute(attribute))
  return Number.isFinite(limit) && limit > 0 ? limit : Infinity
}

/**
 * Read a file input's limits: `data-astro-form-max-files`, `data-astro-form-max-file-bytes`,
 * `data-astro-form-max-total-bytes` and `accept`. An input without `multiple` takes one file whatever its
 * attributes say, as the browser's picker does.
 */
export function readFileLimits(inputElement: HTMLInputElement): FileLimits {
  return {
    maxFiles: inputElement.multiple ? readLimit(inputElement, 'data-astro-form-max-files') : 1,
    maxFileBytes: readLimit(inputElement, 'data-astro-form-max-file-bytes'),
    maxTotalBytes: readLimit(inputElement, 'data-astro-form-max-total-bytes'),
    accept: inputElement.accept
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  }
}

// MARK: - Checks

/**
 * Whether a file matches an `accept` list. The server checks every file's bytes, so this check only spares the
 * person a wasted send: a file the browser gives no type (HEIC on some systems) passes, and an extension
 * matches whatever its case.
 */
function isAccepted(file: File, accept: readonly string[]): boolean {
  if (accept.length === 0 || file.type === '') return true

  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()
  return accept.some((token) => {
    if (token.startsWith('.')) return name.endsWith(token)
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1))

    return type === token
  })
}

/**
 * Check chosen files against a field's limits, in the order they were chosen, returning each file's problem or
 * `null`. Only a file without a problem counts towards the count and the total, so removing every flagged file
 * always leaves a selection the field accepts.
 *
 * @param files - The chosen files, in order.
 * @param limits - The field's limits.
 * @returns One entry per file: its problem, or `null` for a file that passes.
 */
export function checkFiles(files: readonly File[], limits: FileLimits): (FileProblem | null)[] {
  let acceptedCount = 0
  let acceptedBytes = 0
  return files.map((file) => {
    if (!isAccepted(file, limits.accept)) return 'fileType'
    if (file.size > limits.maxFileBytes) return 'fileTooLarge'
    if (acceptedCount >= limits.maxFiles) return 'tooManyFiles'
    if (acceptedBytes + file.size > limits.maxTotalBytes) return 'filesTooLarge'

    acceptedCount++
    acceptedBytes += file.size
    return null
  })
}

// MARK: - Description

/** Joins items for a sentence: `PDF`, `JPEG or PDF`, `JPEG, PNG or PDF`. */
function joinAlternatives(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')

  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** A content type as a person might name it: `image/jpeg` as `JPEG`, `image/*` as `image files`. */
function nameContentType(token: string): string {
  const [type = '', subtype = ''] = token.split('/')
  return subtype === '*' ? `${type} files` : subtype.toUpperCase()
}

/**
 * Name the accepted types for a sentence, from an `accept` list: its extensions when it has any (`JPG, PNG or
 * PDF`), otherwise its content types. The fallback for an input without `data-astro-form-accepted-types`, which
 * `uploadInputAttributes` writes in the server's own wording (`PDF or Word`).
 *
 * @param accept - The input's `accept` tokens.
 * @returns The types joined as alternatives, empty when the list is.
 */
export function describeAcceptedTypes(accept: readonly string[]): string {
  const extensions = accept.filter((token) => token.startsWith('.'))
  const names =
    extensions.length > 0 ? extensions.map((token) => token.slice(1).toUpperCase()) : accept.map(nameContentType)
  return joinAlternatives([...new Set(names)])
}

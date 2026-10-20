import { formatFileSize } from '#client/file-size.js'
import { fillPlaceholders } from '#client/placeholders.js'
import { describeAcceptedTypes } from '#files/accepted-types.js'
import type { FileMatcher } from '#files/sniff.js'
import { assertFileLimitOptions } from '#numeric-options.js'

/**
 * The limits and types of a file field, declared once. The option names match the upload enrichers' and
 * `createUploadRoute`'s, so the object spreads straight into any of them.
 */
export interface UploadRules {
  /** Maximum number of files. */
  maxFiles: number

  /**
   * Maximum size of a single file, in bytes, at most `maxTotalBytes`. Omit it for no separate per-file limit:
   * {@link uploadRules} then sets it to `maxTotalBytes`, so no enricher default applies behind the rules' back.
   */
  maxFileBytes?: number

  /** Maximum combined size of all files, in bytes. */
  maxTotalBytes: number

  /** The accepted types, as the matchers the server checks the files' bytes against. */
  accept: readonly FileMatcher[]

  /** Whether the field must carry a file. */
  required?: boolean
}

/**
 * Validates upload rules and freezes them, so one shared definition can't be changed by whichever route or
 * component imports it. The returned rules always carry `maxFileBytes`: when the caller omits it, it is
 * `maxTotalBytes`, so the server, the input's attributes and the hint all state the same limits and none
 * falls back to an enricher's default.
 *
 * @param rules - The limits and accepted types.
 * @returns The rules, frozen, with `maxFileBytes` resolved.
 * @throws When a limit is not a finite positive number (`maxFiles` must also be a whole number), or
 *   `maxFileBytes` exceeds `maxTotalBytes`.
 */
export function uploadRules(rules: UploadRules): Readonly<UploadRules & { maxFileBytes: number }> {
  assertFileLimitOptions('uploadRules', rules)

  if (rules.maxFileBytes !== undefined && rules.maxFileBytes > rules.maxTotalBytes) {
    throw new Error(
      `uploadRules \`maxFileBytes\` (${rules.maxFileBytes}) must be at most \`maxTotalBytes\` (${rules.maxTotalBytes}).`
    )
  }

  return Object.freeze({
    ...rules,
    maxFileBytes: rules.maxFileBytes ?? rules.maxTotalBytes,
    accept: Object.freeze([...rules.accept])
  })
}

/**
 * The attributes a file input needs to agree with the server: `accept` (content types, then extensions),
 * `multiple`, `required`, and the limit attributes the form script reads (the per-file limit is
 * `maxTotalBytes` for rules that set none). Boolean attributes are `true`, so
 * the object spreads onto an `<input>` in an Astro component.
 *
 * @param rules - The upload rules.
 * @returns The attributes, as strings except for the boolean ones.
 */
export function uploadInputAttributes(rules: UploadRules): Record<string, string | true> {
  const contentTypes = rules.accept.map((matcher) => matcher.contentType)
  const extensions = rules.accept.flatMap((matcher) => (matcher.extensions ?? []).map((extension) => `.${extension}`))

  const attributes: Record<string, string | true> = {
    accept: [...new Set([...contentTypes, ...extensions])].join(',')
  }
  if (rules.maxFiles > 1) attributes.multiple = true
  if (rules.required) attributes.required = true

  attributes['data-astro-form-max-files'] = String(rules.maxFiles)
  attributes['data-astro-form-max-file-bytes'] = String(rules.maxFileBytes ?? rules.maxTotalBytes)
  attributes['data-astro-form-max-total-bytes'] = String(rules.maxTotalBytes)

  return attributes
}

/**
 * The hint's default wording for the rules' shape: one file, many files with a limit each, or many files
 * with only a total (a per-file limit equal to the total says nothing the total doesn't).
 */
function defaultTemplate(rules: UploadRules, maxFileBytes: number): string {
  if (rules.maxFiles === 1) return `One file, up to ${formatFileSize(maxFileBytes)}. Accepted: {types}.`
  if (maxFileBytes >= rules.maxTotalBytes) return 'Up to {maxFiles} files, {maxTotalSize} in total. Accepted: {types}.'

  return 'Up to {maxFiles} files, {maxFileSize} each, {maxTotalSize} in total. Accepted: {types}.'
}

/**
 * Describes the rules to the person filling in the form, in a sentence such as "Up to 5 files, 10 MB each,
 * 50 MB in total. Accepted: JPEG, PNG or PDF." A site's own `template` replaces the default wording and may
 * use `{maxFiles}`, `{maxFileSize}`, `{maxTotalSize}` and `{types}`; a token with no value is left as written.
 * `{maxFileSize}` is the total size for rules that set no per-file limit.
 *
 * @param rules - The upload rules.
 * @param template - The site's wording, with `{name}` tokens. Default: a sentence fitted to the rules.
 * @returns The filled sentence.
 */
export function describeUploadRules(rules: UploadRules, template?: string): string {
  const maxFileBytes = Math.min(rules.maxFileBytes ?? rules.maxTotalBytes, rules.maxTotalBytes)
  const values: Record<string, string> = {
    maxFiles: String(rules.maxFiles),
    maxFileSize: formatFileSize(maxFileBytes),
    maxTotalSize: formatFileSize(rules.maxTotalBytes),
    types: describeAcceptedTypes(rules.accept)
  }

  return fillPlaceholders(template ?? defaultTemplate(rules, maxFileBytes), values)
}

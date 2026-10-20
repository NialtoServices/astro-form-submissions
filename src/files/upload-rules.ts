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

  /** Maximum size of a single file, in bytes. Omit it to leave the per-file limit to the enricher's default. */
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
 * component imports it.
 *
 * @param rules - The limits and accepted types.
 * @returns The rules, frozen.
 * @throws When a limit is not a finite positive number (`maxFiles` must also be a whole number).
 */
export function uploadRules(rules: UploadRules): Readonly<UploadRules> {
  assertFileLimitOptions('uploadRules', rules)

  return Object.freeze({ ...rules, accept: Object.freeze([...rules.accept]) })
}

/**
 * The attributes a file input needs to agree with the server: `accept` (content types, then extensions),
 * `multiple`, `required`, and the limit attributes the form script reads. Boolean attributes are `true`, so
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
  if (rules.maxFileBytes !== undefined) attributes['data-astro-form-max-file-bytes'] = String(rules.maxFileBytes)
  attributes['data-astro-form-max-total-bytes'] = String(rules.maxTotalBytes)

  return attributes
}

/**
 * The hint's default wording for the rules' shape: one file, many files with a limit each, or many files
 * with only a total.
 */
function defaultTemplate(rules: UploadRules): string {
  if (rules.maxFiles === 1) {
    const singleFileBytes = Math.min(rules.maxFileBytes ?? Infinity, rules.maxTotalBytes)
    return `One file, up to ${formatFileSize(singleFileBytes)}. Accepted: {types}.`
  }

  if (rules.maxFileBytes === undefined) return 'Up to {maxFiles} files, {maxTotalSize} in total. Accepted: {types}.'

  return 'Up to {maxFiles} files, {maxFileSize} each, {maxTotalSize} in total. Accepted: {types}.'
}

/**
 * Describes the rules to the person filling in the form, in a sentence such as "Up to 5 files, 10 MB each,
 * 50 MB in total. Accepted: JPEG, PNG or PDF." A site's own `template` replaces the default wording and may
 * use `{maxFiles}`, `{maxFileSize}`, `{maxTotalSize}` and `{types}`; a token with no value (`{maxFileSize}`
 * when the rules set no per-file limit) is left as written.
 *
 * @param rules - The upload rules.
 * @param template - The site's wording, with `{name}` tokens. Default: a sentence fitted to the rules.
 * @returns The filled sentence.
 */
export function describeUploadRules(rules: UploadRules, template?: string): string {
  const values: Record<string, string> = {
    maxFiles: String(rules.maxFiles),
    maxTotalSize: formatFileSize(rules.maxTotalBytes),
    types: describeAcceptedTypes(rules.accept)
  }
  if (rules.maxFileBytes !== undefined) values.maxFileSize = formatFileSize(rules.maxFileBytes)

  return fillPlaceholders(template ?? defaultTemplate(rules), values)
}

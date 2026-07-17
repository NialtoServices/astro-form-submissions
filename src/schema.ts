import { type StandardSchemaV1 } from '@standard-schema/spec'
import { formError, resolveCopy, type FormError, type FormErrors, type ValidationFailure } from '#errors.js'
import { getField } from '#form-data.js'
import { type FormSubmission } from '#pipeline.js'

// A form field literally named `__proto__` (etc.) must not reach the validated object's prototype;
// the same keys are skipped when mapping field errors below.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * The one schema-stage error: the generic summary for a validation failure (of one field or many).
 * Per-field detail lives in `fieldErrors`. Overridable/localizable per site via the `errors`
 * resolver, like any other toolkit-owned keyed error.
 */
export const validationFailed: FormError = formError(
  'validationFailed',
  400,
  'Please correct the errors and try again.'
)

// MARK: - Schema input

/**
 * Context handed to a `schema` factory to build a request-specific validator — the i18n hook: read
 * `context.data.get('lang')` and return a locale-aware validator.
 */
export interface SchemaContext {
  /** The submitted form data (already read), e.g. to choose copy by a `lang` field. */
  data: FormData

  /** The current request's URL. Its host can be proxy/client-influenced, so prefer `siteURL` for trust decisions. */
  requestURL: URL

  /** The configured site URL (Astro `site`), or `undefined` when unset — the trusted origin (never request-derived). */
  siteURL?: URL

  /**
   * The instant the submission arrived (stamped once when the request reaches the route), shared by
   * every stage so all rendered output agrees on one time. Do not mutate.
   */
  readonly submittedAt: Date
}

/**
 * A site's validator, or a factory building one per request from the {@link SchemaContext} (for
 * per-request needs like localized field copy).
 */
export type SchemaInput = StandardSchemaV1 | ((context: SchemaContext) => StandardSchemaV1)

/** The concrete validator a {@link SchemaInput} resolves to. */
type ValidatorOf<S extends SchemaInput> = S extends (context: SchemaContext) => infer R
  ? R extends StandardSchemaV1
    ? R
    : never
  : S extends StandardSchemaV1
    ? S
    : never

/**
 * The submission handed to inspectors/enrichers/dispatchers: the schema's validated output, inferred so
 * the type can't drift from the validation. Request/site context (siteURL, etc.) is not merged in — it
 * travels on each stage's context.
 *
 * The output is constrained to a {@link FormSubmission} via `infer O extends FormSubmission` rather than
 * intersected with it: intersecting would widen `keyof` to `string | number`, collapsing the
 * `keyof E & string` field-key checks (in `FieldSpec`/`FieldInput`) to plain `string` so typos in a
 * `fields` list pass. Constraining instead keeps the real key union for a concrete object output while
 * still satisfying every `E extends FormSubmission` stage bound. An output that isn't a record (the
 * Standard Schema spec leaves `Output` unconstrained, so a generic `S` isn't provably one) falls back to
 * the base record, which the route already fails closed on at runtime.
 */
export type Submission<S extends SchemaInput> =
  StandardSchemaV1.InferOutput<ValidatorOf<S>> extends infer Output extends FormSubmission ? Output : FormSubmission

/**
 * Resolve a {@link SchemaInput} to this request's validator. A factory is detected by the absence of
 * the `~standard` marker, so a callable validator is still used directly rather than invoked.
 */
export function resolveValidator(schema: SchemaInput, context: SchemaContext): StandardSchemaV1 {
  return '~standard' in schema ? schema : schema(context)
}

// MARK: - Form data flattening

/**
 * Flatten form data into the trimmed plain object the schema validates: one value per field name,
 * strings trimmed with blank/whitespace-only values dropped (so `.optional()` and format checks
 * behave), and non-string values (`File` uploads) omitted — uploads are the enricher's concern and
 * inspectors read the raw form data. Multi-valued text fields aren't a `schema` concern; only the
 * first value of each name is taken.
 *
 * @param data - The submitted form data.
 * @returns A null-prototype object of the trimmed single-valued text fields.
 */
export function formDataToObject(data: FormData): Record<string, string> {
  const object: Record<string, string> = Object.create(null)
  for (const key of new Set(data.keys())) {
    if (DANGEROUS_KEYS.has(key)) continue

    const value = getField(data, key)
    if (value !== undefined) object[key] = value
  }
  return object
}

// MARK: - Issue mapping

/** Normalize a Standard Schema issue path's first segment to the form field name. */
function fieldName(path: StandardSchemaV1.Issue['path']): string | undefined {
  const segment = path?.[0]
  if (segment === undefined) return undefined

  const key = typeof segment === 'object' ? segment.key : segment
  return String(key)
}

/**
 * Map Standard Schema issues to the wire shape. Per-field copy is the validator's own `issue.message`
 * (authored in the schema, or the library's default) — the toolkit reads only `message` and `path`,
 * never a vendor issue code, so nothing couples to Zod. The summary is **always** the generic
 * `validationFailed` copy (resolved through the `errors` override), for one field or many, so the wire
 * shape is uniform and the detail lives entirely in `fieldErrors`.
 *
 * @param issues - The Standard Schema failure issues.
 * @param overrides - The site's copy overrides, applied to the `validationFailed` summary.
 * @param data - The submitted form data, for a resolver override.
 * @returns The summary and per-field messages, ready to serialize.
 */
export function mapIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
  overrides?: FormErrors,
  data?: FormData
): ValidationFailure {
  const fieldErrors: Record<string, string> = {}
  for (const issue of issues) {
    const field = fieldName(issue.path)

    // First issue per field wins; dangerous names are skipped so the object can never gain a prototype
    // entry a client would then look up as a real field.
    if (field !== undefined && !DANGEROUS_KEYS.has(field) && !Object.hasOwn(fieldErrors, field)) {
      fieldErrors[field] = issue.message
    }
  }

  const summary = resolveCopy(validationFailed.key, validationFailed.message, overrides, { data })
  return { summary, fieldErrors }
}

import { type DispatchContext } from '#dispatchers/dispatcher.js'
import { type FormSubmission } from '#pipeline.js'
import { humanise } from '#strings.js'

/**
 * Declarative description of one presentational field: read a value with `key`, or compute one with
 * `value` (which also gets the dispatch context). A field resolving to empty/absent is dropped.
 */
export interface FieldSpec<E extends FormSubmission = FormSubmission> {
  /** The key of the submission field to read. */
  key?: keyof E & string

  /** A function to compute the field value. If both `key` and `value` are provided, `value` takes precedence. */
  value?: (submission: E, context: DispatchContext) => string | number | undefined | null

  /** Field label. Defaults to a humanised form of `key` (e.g. `preferredTime` → `Preferred Time`). */
  label?: string
}

/** A bare submission key is shorthand for `{ key }`. */
export type FieldInput<E extends FormSubmission = FormSubmission> = (keyof E & string) | FieldSpec<E>

/** A field resolved to a displayable label/value pair. */
export interface ResolvedField {
  /** The human-readable field label. */
  label: string

  /** The field's displayable value. */
  value: string
}

/**
 * Resolves one field input against a submission: normalises a bare key to a spec, resolves the
 * value, and derives the label (explicit `label`, else humanised `key`).
 *
 * @param input - The field input to resolve.
 * @param submission - The submission to read from.
 * @param context - The dispatch context, passed to computed values.
 * @returns The resolved field, or `null` when the value or label resolves empty.
 */
export function resolveField<E extends FormSubmission>(
  input: FieldInput<E>,
  submission: E,
  context: DispatchContext
): ResolvedField | null {
  const spec: FieldSpec<E> = typeof input === 'string' ? { key: input } : input

  const value = spec.value ? spec.value(submission, context) : spec.key ? submission[spec.key] : undefined
  if (value === undefined || value === null || value === '') return null

  const label = spec.label ?? (spec.key ? humanise(spec.key) : '')
  if (!label) return null

  return { label, value: String(value) }
}

/**
 * Resolves a list of field inputs, dropping any that resolve empty.
 *
 * @param inputs - The field inputs to resolve.
 * @param submission - The submission to read from.
 * @param context - The dispatch context, passed to computed values.
 * @returns The resolved fields, in input order.
 */
export function resolveFields<E extends FormSubmission>(
  inputs: FieldInput<E>[],
  submission: E,
  context: DispatchContext
): ResolvedField[] {
  return inputs.map((input) => resolveField(input, submission, context)).filter((field) => field !== null)
}

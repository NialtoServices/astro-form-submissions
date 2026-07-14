/**
 * A user-facing form error: a stable `key` (the override/i18n handle), the HTTP `status`, and default
 * `message`. No central registry — any stage mints keys with {@link formError} (the schema stage's is
 * `validationFailed`).
 */
export interface FormError {
  /** Stable identifier a site overrides copy by (via `config.errors`). */
  key: string

  /** The HTTP status the request fails with. */
  status: number

  /** Default user-facing copy, owned by whoever raises the error. */
  message: string
}

/**
 * Builds a {@link FormError} value.
 *
 * @param key - Stable identifier a site overrides copy by.
 * @param status - The HTTP status the request fails with.
 * @param message - Default user-facing copy.
 * @returns The error value, ready to reject or refuse with.
 */
export function formError(key: string, status: number, message: string): FormError {
  return { key, status, message }
}

/** What the copy resolver may read about the request — the form data, absent for pre-body guard errors. */
export interface CopyContext {
  /** The submitted form data (for an i18n resolver to read e.g. `lang`); `undefined` for pre-body guard errors. */
  data?: FormData
}

/**
 * Resolves a {@link FormError}'s copy from its key, default, and request context; returns replacement
 * copy or `undefined` to keep the default. The i18n-capable generalisation of the static map.
 */
export type CopyResolver = (key: string, defaultMessage: string, context: CopyContext) => string | undefined

/**
 * Every error key the toolkit itself raises — the handles a site's `errors` map overrides copy by. Not
 * a runtime registry (errors stay values that live with their raiser); it exists to give the `errors`
 * map **autocomplete** and to key {@link DEFAULT_ERROR_COPY}. A site's own guards/inspectors may still
 * mint keys outside this set.
 */
export type ToolkitErrorKey =
  | 'invalidForm'
  | 'send'
  | 'unavailable'
  | 'validationFailed'
  | 'verification'
  | 'rateLimited'
  | 'tooManyFiles'
  | 'fileTooLarge'
  | 'fileType'

/**
 * Per-site copy overrides keyed by {@link FormError.key}: a static map, or a {@link CopyResolver} for
 * i18n. Applies to toolkit-owned errors only, never a schema's own field messages.
 *
 * The map's keys suggest the {@link ToolkitErrorKey}s for autocomplete, while `(string & {})` keeps it
 * open to a site's own guard/inspector keys — so a typo on a known key is not itself an error.
 */
export type FormErrors = Partial<Record<ToolkitErrorKey | (string & {}), string>> | CopyResolver

/**
 * Resolve a {@link FormError}'s user-facing copy, preferring the site's override for its key over the
 * error's own default. A map form is own-property + type guarded (keys like `toString`/`__proto__`
 * resolve to the site's own entry or the default, never an inherited member); a resolver form may
 * return `undefined` to fall back to the default.
 *
 * @param key - The error's stable key.
 * @param defaultMessage - The error's own default copy.
 * @param overrides - The site's overrides, if any.
 * @param context - What the resolver may read about the request.
 * @returns The resolved copy.
 */
export function resolveCopy(
  key: string,
  defaultMessage: string,
  overrides: FormErrors | undefined,
  context: CopyContext
): string {
  if (typeof overrides === 'function') {
    // A resolver is consumer code, and the route's recovery path calls it while building a *failure*
    // response — an uncontained throw here would re-throw during recovery and reject the request
    // instead of returning the documented JSON error. Fall back to the default.
    try {
      const resolved = overrides(key, defaultMessage, context)
      return typeof resolved === 'string' ? resolved : defaultMessage
    } catch {
      return defaultMessage
    }
  }

  const override = overrides !== undefined && Object.hasOwn(overrides, key) ? overrides[key] : undefined
  return typeof override === 'string' ? override : defaultMessage
}

/** A validation failure ready to serialize: a human summary and per-field messages (both resolved). */
export interface ValidationFailure {
  /** The summary shown in the central status region. */
  summary: string

  /** Per-field messages keyed by form field name; empty when no issue carried a path. */
  fieldErrors: Record<string, string>
}

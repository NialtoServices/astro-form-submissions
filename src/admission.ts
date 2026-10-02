import type { StandardSchemaV1 } from '@standard-schema/spec'
import { formError, type FormError, type FormErrors } from '#errors.js'
import type { AdmittingRoute, Guard, GuardContext } from '#guards/index.js'
import type { InspectionContext, Inspector } from '#inspectors/index.js'
import type { FormErrorStage } from '#reporting.js'
import { jsonFormError, jsonValidationError } from '#responses.js'
import {
  formDataToObject,
  mapIssues,
  resolveValidator,
  validationFailed,
  type SchemaContext,
  type SchemaInput,
  type Submission
} from '#schema.js'
import type { APIContext } from 'astro'

// MARK: - Errors

/** Errors the route factories themselves raise. Override the copy per-site via `errors[key]`. */
export const ERRORS = {
  invalidForm: formError('invalidForm', 400, 'Invalid form data.'),
  send: formError('send', 502, 'Could not send your message right now. Please try again or call us directly.'),
  unavailable: formError(
    'unavailable',
    500,
    'This form is temporarily unavailable. Please email us directly or call us.'
  ),

  // Owned by the schema stage (raised from `mapIssues`); surfaced here so the toolkit's built-in keys sit together.
  validationFailed
} as const

// MARK: - Admission

/** The stages that decide whether a request is let in: identical for the form route and the upload route. */
export interface AdmissionConfig<S extends SchemaInput> {
  guards?: Guard[]
  schema: S
  inspectors?: Inspector<Submission<S>>[]
  errors?: FormErrors

  /**
   * Resolves the client's address for every stage (the rate-limit key, Turnstile's `remoteip`, and
   * `clientAddress` on each context). Default: Astro's `context.clientAddress`, which on some adapters
   * (Node behind a proxy, say) comes from a header the client can set. Pass a resolver that reads only
   * what your own infrastructure vouches for. A resolver that throws resolves to `undefined`.
   */
  clientAddress?: ClientAddressResolver
}

/** Resolves the client's address from a request's Astro context, or `undefined` when it can't. */
export type ClientAddressResolver = (context: APIContext) => string | undefined

/**
 * The client address lookup a route shares across its stages: the site's resolver when given, else
 * Astro's own. Astro's getter throws in prerendered/static contexts; resolving to `undefined` keeps a
 * fail-closed anti-bot inspector running there.
 *
 * @param context - The request's Astro context.
 * @param resolver - The site's resolver, if any.
 * @returns A lookup that never throws.
 */
export function clientAddressLookup(context: APIContext, resolver?: ClientAddressResolver): () => string | undefined {
  return () => {
    try {
      return resolver ? resolver(context) : context.clientAddress
    } catch {
      return undefined
    }
  }
}

/** What admission reads about the request, and the route's reporters. */
export interface AdmissionRequest {
  route: AdmittingRoute
  request: Request
  url: URL
  site?: URL
  submittedAt: Date
  clientAddress: () => string | undefined

  /** Reports and awaits (for failures that change the response). */
  report: (error: unknown, stage: FormErrorStage) => Promise<void>

  /** Reports without awaiting; the route drains these before it responds. */
  registerReport: (error: unknown, stage: FormErrorStage) => void
}

/**
 * Admission's outcome: a response to return as-is (a refusal), a silent `drop`, or an admitted
 * submission, possibly quarantined.
 */
export type Admission<S extends SchemaInput> =
  | { outcome: 'respond'; response: Response }
  | { outcome: 'drop' }
  | {
      outcome: 'admitted'
      formData: FormData
      submission: Submission<S>
      quarantined: boolean
      quarantineReasons: string[]
    }

/**
 * Runs guards (before the body is read), parses the body, validates it against the schema, and runs
 * the inspectors in order.
 *
 * @param config - The guards, schema, inspectors and copy overrides.
 * @param request - The request and the route's reporters.
 * @returns The admission outcome.
 */
export async function admit<S extends SchemaInput>(
  config: AdmissionConfig<S>,
  request: AdmissionRequest
): Promise<Admission<S>> {
  const { url, site, submittedAt, report, registerReport, clientAddress } = request

  // `data` reaches a resolver override so it can localise; pre-body guard failures pass none, so
  // their copy falls back to the default locale (there's no body to read a `lang` field from yet).
  const fail = (error: FormError, data?: FormData): Admission<S> => ({
    outcome: 'respond',
    response: jsonFormError(error, config.errors, { data })
  })

  // A quarantine verdict from any guard or inspector accumulates here (non-terminal, so later
  // stages still run) and is applied at dispatch: only dispatchers with `acceptsQuarantined` deliver.
  let quarantined = false
  const quarantineReasons: string[] = []

  const guardContext: GuardContext = {
    request: request.request,
    requestURL: url,
    route: request.route,
    siteURL: site,
    submittedAt,
    report: (error) => registerReport(error, 'guard'),
    get clientAddress(): string | undefined {
      return clientAddress()
    }
  }

  for (const guard of config.guards ?? []) {
    let result
    try {
      result = await guard.guard(guardContext)
    } catch (error) {
      // Default fail-open: a broken guard must not block every submission. A guard that opts into
      // `failClosed` fails the request on its bug instead (there's no meaningful user-facing reason).
      await report(error, 'guard')
      if (guard.failClosed) return fail(ERRORS.unavailable)
      continue
    }

    if (!result) continue
    if (result.action === 'reject') return fail(result.error)
    if (result.action === 'drop') return { outcome: 'drop' }

    // Non-terminal: record and keep going. A later drop/reject still short-circuits and wins.
    if (result.action === 'quarantine') {
      quarantined = true
      if (result.reason !== undefined) quarantineReasons.push(result.reason)
    }
  }

  const formData = await request.request.formData().catch(() => undefined)
  if (!formData) return fail(ERRORS.invalidForm)

  const schemaContext: SchemaContext = { data: formData, requestURL: url, siteURL: site, submittedAt }
  let validation: StandardSchemaV1.Result<unknown>
  try {
    const validator = resolveValidator(config.schema, schemaContext)
    validation = await validator['~standard'].validate(formDataToObject(formData))
  } catch (error) {
    // A throwing schema is the site's bug, as a non-object output is below; fail closed with the form
    // data, so a localising copy resolver still answers in the sender's language.
    await report(error, 'unexpected')
    return fail(ERRORS.unavailable, formData)
  }

  // Standard Schema signals failure by the *presence* of `issues` — an empty array is still a
  // failure, so fail closed on any issues result. `mapIssues([])` yields the generic summary with no fieldErrors.
  if (validation.issues) {
    return { outcome: 'respond', response: jsonValidationError(mapIssues(validation.issues, config.errors, formData)) }
  }

  // A conformant success carries `value`; a result with neither issues nor value is non-conformant,
  // so reject rather than dispatch an empty submission.
  if (!('value' in validation)) return fail(ERRORS.invalidForm, formData)

  // Every stage indexes/spreads the submission, so enforce the record precondition here: a schema
  // that transforms to a scalar/array/null is a misconfiguration — report it and fail closed rather
  // than object-spread it into a garbage submission.
  const value = validation.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    await report(new Error('Schema output must be an object'), 'unexpected')
    return fail(ERRORS.unavailable, formData)
  }

  const submission = value as Submission<S>

  const inspectionContext: InspectionContext<Submission<S>> = {
    submission,
    data: formData,
    requestURL: url,
    siteURL: site,
    submittedAt,

    // The inspectors' diagnostics channel, drained before the response returns.
    report: (error) => registerReport(error, 'inspection'),
    get clientAddress(): string | undefined {
      return clientAddress()
    }
  }

  for (const inspector of config.inspectors ?? []) {
    let result
    try {
      result = await inspector.inspect(inspectionContext)
    } catch (error) {
      // Default fail-open: an unexpected throw is the inspector's bug, not the sender's — skip it
      // rather than reject every submission. An inspector that opts into `failClosed` fails the
      // request on its bug instead; one that fails closed on its own expected failures returns `{ reject }`.
      await report(error, 'inspection')
      if (inspector.failClosed) return fail(ERRORS.unavailable, formData)
      continue
    }

    // The type requires an explicit result, but an untyped consumer could still return nothing;
    // treat that as an accept (fail-open, consistent with how a throwing inspector is handled).
    if (!result) continue
    if (result.action === 'reject') return fail(result.error, formData)
    if (result.action === 'drop') return { outcome: 'drop' }

    // Non-terminal: record and keep going. A later drop/reject still short-circuits and wins.
    if (result.action === 'quarantine') {
      quarantined = true
      if (result.reason !== undefined) quarantineReasons.push(result.reason)
    }
  }

  return { outcome: 'admitted', formData, submission, quarantined, quarantineReasons }
}

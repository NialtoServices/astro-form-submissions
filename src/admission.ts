import type { StandardSchemaV1 } from '@standard-schema/spec'
import { formError, type FormError, type FormErrors } from '#errors.js'
import type { AdmittingRoute, Guard, GuardContext } from '#guards/index.js'
import type { InspectionContext, Inspector } from '#inspectors/index.js'
import { OperationalError } from '#operational-error.js'
import type { Verdict } from '#pipeline.js'
import type { FormErrorStage } from '#reporting.js'
import { jsonFormError, jsonValidationError } from '#responses.js'
import {
  formDataToObject,
  issueFields,
  mapIssues,
  resolveValidator,
  validationFailed,
  type SchemaContext,
  type SchemaInput,
  type Submission
} from '#schema.js'
import { SubmissionVerdictError } from '#submission-verdict-error.js'
import type { APIContext } from 'astro'

// MARK: - Errors

/** Errors the route factories themselves raise. Override the copy per-site via `errors[key]`. */
export const ERRORS = {
  invalidForm: formError('invalidForm', 400, 'Invalid form data.'),
  requestTooLarge: formError(
    'requestTooLarge',
    413,
    'Your submission is too large to send. Please shorten it or remove some files.'
  ),
  send: formError('send', 502, 'Could not send your message right now. Please try again or call us directly.'),
  unavailable: formError(
    'unavailable',
    500,
    'This form is temporarily unavailable. Please email us directly or call us.'
  ),

  // Owned by the schema stage (raised from `mapIssues`); surfaced here so the toolkit's built-in keys sit together.
  validationFailed
} as const

// MARK: - Body

/** The largest multipart body a route reads when it carries no files: far beyond any text a form submits. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/**
 * The largest body a route reads when it isn't multipart (an urlencoded form, say): such a body carries no
 * files, and Node's urlencoded parser slows quadratically on a crafted one, taking seconds at 1 MiB.
 */
export const DEFAULT_MAX_TEXT_BODY_BYTES = 64 * 1024

/**
 * Whether the request declares a multipart body, the only kind that can carry files. A `Content-Type` that
 * joins several types with commas never qualifies: the parser reads the last of them, so a header that opens
 * with `multipart/form-data` could still have its body parsed as urlencoded under the larger limit. A comma
 * inside a quoted parameter, such as a quoted boundary, doesn't count.
 */
function isMultipart(request: Request): boolean {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()
  const unquoted = contentType.replace(/"(?:[^"\\]|\\.)*"/g, '')
  return contentType.startsWith('multipart/form-data') && !unquoted.includes(',')
}

/**
 * Parses the request body as form data, reading no more than `maxBytes` of it. A declared `Content-Length`
 * over the limit is refused before a byte is read; a body that runs past it is cut off there, so no more than
 * the limit is read however the length was declared. Parsing then holds roughly two to three times that.
 *
 * @param request - The request whose body to read.
 * @param maxBytes - The most body bytes to read.
 * @returns The form data, `'too-large'` past the limit, or `undefined` when the body isn't form data.
 */
async function readFormData(request: Request, maxBytes: number): Promise<FormData | 'too-large' | undefined> {
  if (Number(request.headers.get('content-length')) > maxBytes) return 'too-large'
  if (!request.body) return request.formData().catch(() => undefined)

  let receivedBytes = 0
  let tooLarge = false
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength
        if (receivedBytes > maxBytes) {
          tooLarge = true
          controller.error(new RangeError(`The request body exceeds ${maxBytes} bytes.`))
          return
        }

        controller.enqueue(chunk)
      }
    })
  )

  const contentType = request.headers.get('content-type')
  const formData = await new Response(counted, { headers: contentType ? { 'Content-Type': contentType } : {} })
    .formData()
    .catch(() => undefined)
  return tooLarge ? 'too-large' : formData
}

// MARK: - Admission

/** The stages that decide whether a request is let in: identical for the form route and the upload route. */
export interface AdmissionConfig<S extends SchemaInput> {
  guards?: Guard[]
  schema: S
  inspectors?: Inspector<Submission<S>>[]
  errors?: FormErrors

  /**
   * The most request-body bytes the route reads. A larger body is refused with `requestTooLarge` (413)
   * before it's parsed, and reading stops as soon as the limit is passed. Default
   * {@link DEFAULT_MAX_BODY_BYTES}; the form route adds each `FileUploads` enricher's `maxTotalBytes`.
   */
  maxBodyBytes?: number

  /**
   * The most bytes the route reads from a body that isn't multipart, such as an urlencoded form, within
   * `maxBodyBytes`. Default {@link DEFAULT_MAX_TEXT_BODY_BYTES}.
   */
  maxTextBodyBytes?: number

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
interface AdmissionRequest {
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
type Admission<S extends SchemaInput> =
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
 * The report for a guard's or inspector's verdict: a {@link SubmissionVerdictError} for a refusal, drop or
 * quarantine, and `undefined` for an accept or an action an untyped stage invented.
 */
function verdictError(verdict: Verdict): SubmissionVerdictError | undefined {
  if (verdict.action !== 'reject' && verdict.action !== 'drop' && verdict.action !== 'quarantine') return undefined

  return new SubmissionVerdictError(verdict.action, verdict.code, verdict.details)
}

/**
 * Runs guards (before the body is read), parses up to `maxBodyBytes` of the body (`maxTextBodyBytes` when it
 * isn't multipart), validates it against the schema, and runs the inspectors in order.
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

    const guardVerdict = verdictError(result)
    if (guardVerdict) registerReport(guardVerdict, 'guard')

    if (result.action === 'reject') return fail(result.error)
    if (result.action === 'drop') return { outcome: 'drop' }

    // Non-terminal: record and keep going. A later drop/reject still short-circuits and wins.
    if (result.action === 'quarantine') {
      quarantined = true
      if (result.reason !== undefined) quarantineReasons.push(result.reason)
    }
  }

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const limit = isMultipart(request.request)
    ? maxBodyBytes
    : Math.min(maxBodyBytes, config.maxTextBodyBytes ?? DEFAULT_MAX_TEXT_BODY_BYTES)
  const formData = await readFormData(request.request, limit)
  if (formData === 'too-large') {
    registerReport(new SubmissionVerdictError('reject', 'request.too-large', { limit }), 'validation')
    return fail(ERRORS.requestTooLarge)
  }

  if (!formData) {
    registerReport(new SubmissionVerdictError('reject', 'form.unparseable'), 'validation')
    return fail(ERRORS.invalidForm)
  }

  const schemaContext: SchemaContext = { data: formData, requestURL: url, siteURL: site, submittedAt }
  let validation: StandardSchemaV1.Result<unknown>
  try {
    const validator = resolveValidator(config.schema, schemaContext)
    const input = formDataToObject(formData)

    // An inspector's own fields (a token, a honeypot) are its to read from the raw data, never submission
    // values that a schema keeping undeclared fields could pass on to a dispatcher.
    for (const inspector of config.inspectors ?? []) {
      for (const field of inspector.controlFields ?? []) delete input[field]
    }

    validation = await validator['~standard'].validate(input)
  } catch (error) {
    // A throwing schema is the site's bug, as a non-object output is below; fail closed with the form
    // data, so a localising copy resolver still answers in the sender's language.
    await report(error, 'unexpected')
    return fail(ERRORS.unavailable, formData)
  }

  // Standard Schema signals failure by the *presence* of `issues` — an empty array is still a
  // failure, so fail closed on any issues result. `mapIssues([])` yields the generic summary with no fieldErrors.
  if (validation.issues) {
    registerReport(
      new SubmissionVerdictError('reject', 'schema.invalid', { fields: issueFields(validation.issues) }),
      'validation'
    )
    return { outcome: 'respond', response: jsonValidationError(mapIssues(validation.issues, config.errors, formData)) }
  }

  // A conformant success carries `value`; a result with neither issues nor value is non-conformant,
  // so reject rather than dispatch an empty submission.
  if (!('value' in validation)) {
    registerReport(new SubmissionVerdictError('reject', 'schema.no-value'), 'validation')
    return fail(ERRORS.invalidForm, formData)
  }

  // Every stage indexes/spreads the submission, so enforce the record precondition here: a schema
  // that transforms to a scalar/array/null is a misconfiguration — report it and fail closed rather
  // than object-spread it into a garbage submission.
  const value = validation.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    await report(new OperationalError('schema.non-object', 'Schema output must be an object.'), 'unexpected')
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

    const inspectionVerdict = verdictError(result)
    if (inspectionVerdict) registerReport(inspectionVerdict, 'inspection')

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

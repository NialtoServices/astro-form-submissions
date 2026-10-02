import { admit, ERRORS } from '#admission.js'
import type { DispatchContext, Dispatcher } from '#dispatchers/index.js'
import { FileUploads, UploadedFiles, type Enricher, type EnrichmentContext } from '#enrichers/index.js'
import type { FormError, FormErrors, ToolkitErrorKey } from '#errors.js'
import { RateLimitGuard, type Guard } from '#guards/index.js'
import { TurnstileInspector, type Inspector } from '#inspectors/index.js'
import type { FormSubmission } from '#pipeline.js'
import { containedReporter, type ErrorReporter, type FormErrorStage } from '#reporting.js'
import { jsonFormError, jsonOk } from '#responses.js'
import type { SchemaInput, Submission } from '#schema.js'
import type { APIRoute } from 'astro'

export { ERRORS, type FormErrorStage }

// MARK: - Errors

/**
 * The default copy for every {@link ToolkitErrorKey}, read from the live {@link FormError} each key's
 * raiser owns — so it can never drift from the actual defaults. It is a **reference/checklist** (a
 * localised site translates against it, and can see which keys exist and their wording), not an input:
 * omitting `errors` already yields these, and overriding is still per-key via `config.errors`.
 */
export const DEFAULT_ERROR_COPY: Record<ToolkitErrorKey, string> = {
  invalidForm: ERRORS.invalidForm.message,
  send: ERRORS.send.message,
  unavailable: ERRORS.unavailable.message,
  validationFailed: ERRORS.validationFailed.message,
  verification: TurnstileInspector.errors.verification.message,
  rateLimited: RateLimitGuard.errors.rateLimited.message,
  tooManyFiles: FileUploads.errors.tooManyFiles.message,
  fileTooLarge: FileUploads.errors.fileTooLarge.message,
  fileType: FileUploads.errors.fileType.message,
  uploadMissing: UploadedFiles.errors.uploadMissing.message
}

// MARK: - Config

// MARK: - Resource inference

/** Distributes a union into an intersection — used to merge each enricher's provided resource. */
type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never

/**
 * The resource an enricher provides (its `A`), or `object` for one that provides nothing typed. Both
 * type params are inferred (the submission slot is contravariant, so a fixed one would fail to match);
 * an enricher that only rolls back (no `provide`) leaves `A` as `unknown`, which collapses to `object`
 * so it contributes nothing to the merge rather than poisoning it.
 */
type ProvidedOf<E> = E extends Enricher<infer _Submission, infer A> ? ([unknown] extends [A] ? object : A) : object

/**
 * The merged resources every enricher provides — the type the route hands the dispatchers as
 * `DispatchContext.resources`. `object` when there are no enrichers; the intersection of each enricher's
 * provided `A` otherwise (so an email whose templates read `context.resources.files` only type-checks
 * when some enricher provides `files`).
 */
export type MergedProvided<Es extends readonly unknown[]> = [Es] extends [readonly []]
  ? object
  : UnionToIntersection<ProvidedOf<Es[number]>>

/**
 * Dispatchers that deliver concurrently. Groups in {@link FormRouteConfig.dispatchers} run one after another,
 * and a failed `required` delivery ends the sequence, so a later group can depend on an earlier one having
 * landed (e.g. an acknowledgement only once the owner has the submission).
 */
export type DispatchGroup<E extends FormSubmission = FormSubmission, A = object> = readonly Dispatcher<E, A>[]

export interface FormRouteConfig<
  S extends SchemaInput,
  Es extends readonly Enricher<Submission<S>, unknown>[] = readonly Enricher<Submission<S>, unknown>[]
> {
  /** Cheap gates run before the body is parsed (e.g. body-size cap, rate limit). Each may pass, reject, or drop. */
  guards?: Guard[]

  /**
   * The Standard Schema validator (or a per-request factory, for i18n) that validates and shapes the
   * submission. The submission type and every stage below are inferred from it.
   */
  schema: S

  /** Inspections run in order before delivery (e.g. honeypot, a CAPTCHA/anti-bot check, spam screening). Each may accept, quarantine, drop, or reject. */
  inspectors?: Inspector<Submission<S>>[]

  /**
   * Resource acquisition run after the inspectors (e.g. file uploads). Each acquires a resource onto
   * `context.resources` for the dispatchers and can roll back. The provided resources are inferred and
   * checked against what the dispatchers read.
   */
  enrichers?: Es

  /**
   * Destinations run after the enrichers (e.g. email, a chat webhook): either a flat list, which runs
   * concurrently as one group, or a list of {@link DispatchGroup}s, which run in order. A failed `required`
   * delivery stops later groups. A quarantined submission reaches only those with `acceptsQuarantined`.
   */
  dispatchers?:
    | readonly Dispatcher<Submission<S>, MergedProvided<Es>>[]
    | readonly DispatchGroup<Submission<S>, MergedProvided<Es>>[]

  /**
   * Per-site copy overrides keyed by {@link FormError.key} — a static map, or a {@link CopyResolver}
   * that localises by reading the request. Applies to toolkit-owned errors only, never a schema's own
   * field messages (author those on the validator).
   */
  errors?: FormErrors

  /**
   * Called when an error would otherwise be swallowed (a skipped guard/inspector, a rolled-back
   * enricher, a failed delivery, an unexpected throw). May be async; contained, so it can never change
   * the response.
   *
   * The default logs a **PII-safe summary** (stage, error class, any `code`/`status`) — never the
   * message or object, which can quote submission data. Override it to log the full error where your
   * pipeline can hold that PII.
   */
  onError?: ErrorReporter
}

/**
 * The configured dispatchers as ordered groups: a flat list is one group, a list of groups is itself. A mix,
 * a group nested in a group, or an entry that is not a dispatcher is a misconfiguration the types forbid; an
 * untyped caller learns about it when the route is built rather than as a delivery failure on every
 * submission.
 */
function dispatchGroupsFrom<D>(dispatchers: readonly (D | readonly D[])[]): (readonly D[])[] {
  const groupCount = dispatchers.filter((entry) => Array.isArray(entry)).length
  if (groupCount !== 0 && groupCount !== dispatchers.length) {
    throw new TypeError(
      '`dispatchers` must be a list of dispatchers or a list of dispatch groups, not a mix of dispatchers and groups.'
    )
  }

  const groups = groupCount === 0 ? [dispatchers as readonly D[]] : (dispatchers as (readonly D[])[])
  const isDispatcher = (entry: unknown) =>
    typeof entry === 'object' && entry !== null && typeof (entry as { dispatch?: unknown }).dispatch === 'function'
  if (!groups.every((group) => group.every(isDispatcher))) {
    throw new TypeError(
      '`dispatchers` must contain only dispatchers (objects with a `dispatch` function), in one list or in groups of them.'
    )
  }

  return groups
}

// MARK: - Factory

/**
 * Builds the `POST` handler for a form endpoint: guards (pre-body) → schema validate →
 * inspectors (in order) → enrichers (in order) → dispatchers (concurrently, in groups run in order).
 *
 * A site keeps only its `src/pages/api/<form>.ts` with `export const prerender = false`
 * and `export const POST = createFormRoute({ ... })`.
 */
export function createFormRoute<
  const S extends SchemaInput,
  const Es extends readonly Enricher<Submission<S>, unknown>[] = []
>(config: FormRouteConfig<S, Es>): APIRoute {
  const report = containedReporter(config.onError)

  const dispatchGroups = dispatchGroupsFrom<Dispatcher<Submission<S>, MergedProvided<Es>>>(config.dispatchers ?? [])

  return async (context) => {
    const { request, site, url } = context

    // Threaded through every stage context so the whole pipeline shares one instant — e.g. both emails
    // for a submission render the same time.
    const submittedAt = new Date()

    // `data` reaches a resolver override so it can localise; pre-body guard failures pass none, so
    // their copy falls back to the default locale (there's no body to read a `lang` field from yet).
    const fail = (error: FormError, data?: FormData) => jsonFormError(error, config.errors, { data })

    // Context reporters fire without awaiting; collect their promises and drain them before the
    // response returns, so an async `onError` isn't cut off by a post-response serverless freeze.
    const pendingReports: Promise<void>[] = []
    const registerReport = (error: unknown, stage: FormErrorStage): void => {
      pendingReports.push(report(error, stage))
    }

    // Astro's `clientAddress` getter throws in prerendered/static contexts; resolving to `undefined`
    // keeps a fail-closed anti-bot inspector running there. Shared by all three contexts below.
    const clientAddress = (): string | undefined => {
      try {
        return context.clientAddress
      } catch {
        return undefined
      }
    }

    // Enrichers acquire resources (e.g. upload files) and hand back rollbacks. Declared out here so the
    // outer catch can also unwind them; they run in reverse on any later failure, so a half-finished
    // submission leaves no orphaned resources behind.
    const rollbacks: (() => Promise<void>)[] = []
    const runRollbacks = async (): Promise<void> => {
      // Splicing empties the list, so a second call (e.g. the outer catch after cleanup already ran) is
      // a no-op. A failed cleanup reaches `onError` but never masks the triggering failure or halts the rest.
      for (const rollback of rollbacks.splice(0).reverse()) {
        try {
          await rollback()
        } catch (error) {
          await report(error, 'enrichment')
        }
      }
    }
    let resourcesExposed = false

    try {
      const admission = await admit(config, { request, url, site, submittedAt, clientAddress, report, registerReport })
      if (admission.outcome === 'respond') return admission.response
      if (admission.outcome === 'drop') return jsonOk()

      const { formData, submission, quarantined, quarantineReasons } = admission

      const enrichmentContext: EnrichmentContext<Submission<S>> = {
        submission,
        data: formData,
        requestURL: url,
        siteURL: site,
        submittedAt,
        report: (error) => registerReport(error, 'enrichment'),
        get clientAddress(): string | undefined {
          return clientAddress()
        }
      }

      // What the enrichers acquire, exposed to the dispatchers on `context.resources`. The submission
      // is never mutated — it stays exactly the schema's validated input — so acquired resources live here.
      const resources: Record<string, unknown> = {}

      for (const enricher of config.enrichers ?? []) {
        try {
          const result = await enricher.enrich(submission, enrichmentContext)

          // Interpreting the result — reading `reject`, registering the rollback, merging what was
          // provided — stays inside this try: a hostile getter/proxy that throws mid-interpretation then
          // triggers cleanup rather than escaping to the outer catch with resources already acquired.
          if ('reject' in result) {
            await runRollbacks()
            return fail(result.reject, formData)
          }

          if (result.rollback) rollbacks.push(result.rollback)
          if (result.provide) {
            for (const [key, value] of Object.entries(result.provide)) {
              // A provided key must not reassign the resources object's prototype for the dispatchers
              // that read it (the keys are config-owned, but the guard costs nothing).
              if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue

              resources[key] = value
            }
          }
        } catch (error) {
          // Fail closed: acquisition can't be skipped. Roll back prior enrichers and stop.
          await report(error, 'enrichment')
          await runRollbacks()
          return fail(ERRORS.unavailable, formData)
        }
      }

      const dispatchContext: DispatchContext<MergedProvided<Es>> = {
        requestURL: url,
        siteURL: site,
        submittedAt,
        quarantined,
        quarantineReasons,

        // The dispatchers' declared resource type is `MergedProvided<Es>`; the accumulator is built from
        // the same enrichers, so the assertion states that correspondence TS can't re-derive from the bag.
        resources: resources as MergedProvided<Es>
      }

      let succeeded = 0
      let failed = 0
      let requiredFailed = false
      for (const group of dispatchGroups) {
        await Promise.all(
          group.map(async (dispatcher) => {
            // A quarantined submission is withheld from every destination that hasn't opted in. The skip
            // is a no-op — not a success or failure — so a fully quarantined submission still returns 200.
            if (quarantined && !dispatcher.acceptsQuarantined) return

            try {
              // A per-submission opt-out (e.g. no acknowledgement without a recipient). Evaluated inside
              // the try so a throwing predicate is a delivery failure, not an uncaught rejection; a `false`
              // verdict is a no-op skip — the early return counts as neither delivered nor failed.
              if (dispatcher.deliverWhen && !dispatcher.deliverWhen(submission, dispatchContext)) return

              await dispatcher.dispatch(submission, dispatchContext)
              succeeded += 1

              // A resolved dispatch is a real delivery; unless it declares it doesn't carry the acquired
              // resources, treat it as having exposed them to a recipient.
              if (dispatcher.exposesResources !== false) resourcesExposed = true
            } catch (error) {
              await report(error, 'delivery')
              failed += 1
              if (dispatcher.required) requiredFailed = true
            }
          })
        )

        // A later group may depend on this one having landed (an acknowledgement promises the owner has
        // the submission), so a failed required delivery ends dispatch; the sender's retry then reaches
        // no later group twice.
        if (requiredFailed) break
      }

      // A quarantined submission with nowhere to go is a silent 200 with zero delivery. Computed from
      // the configured dispatchers so it still fires when the array is empty.
      const acceptsQuarantine = dispatchGroups.some((group) =>
        group.some((dispatcher) => dispatcher.acceptsQuarantined === true)
      )
      if (quarantined && !acceptsQuarantine) {
        await report(
          new Error(
            'Submission quarantined but no dispatcher accepts quarantined submissions — nothing was delivered.'
          ),
          'unexpected'
        )
      }

      // Roll back acquired resources unless a delivery that *carries* them succeeded: deleting files
      // whose links a recipient already received would leave dead links. Files no exposing delivery sent
      // (all failed, all skipped, or only non-exposing notifications succeeded) are orphans.
      if (!resourcesExposed && rollbacks.length > 0) await runRollbacks()

      // A `required` failure always fails the request; beyond that, if every *attempted* delivery
      // failed the sender must not be told "sent". Predicate skips are deliberate non-deliveries
      // and still return the silent 200.
      if (requiredFailed || (failed > 0 && succeeded === 0)) return fail(ERRORS.send, formData)

      return jsonOk()
    } catch (error) {
      await report(error, 'unexpected')
      // An unexpected throw after enrichment acquired resources that no exposing delivery kept must not
      // strand them. The per-enricher paths handle their own; `runRollbacks` drains, so this is a no-op
      // once they have already run.
      if (!resourcesExposed && rollbacks.length > 0) await runRollbacks()
      return fail(ERRORS.unavailable)
    } finally {
      // Drain the context reporters (guard/inspector/enricher) so an async `onError` completes
      // before the platform can freeze the isolate after the response.
      await Promise.allSettled(pendingReports)
    }
  }
}

// MARK: - Lazy construction

/** Options for {@link defineLazyRoute}. */
export interface LazyRouteOptions {
  /**
   * Called once per failed build (however many requests were waiting on it), with `stage: 'build'`, before
   * the error is rethrown. A build fails before the route's own `onError` exists, so this is where it reaches
   * your reporter; the signature matches the route's, so one reporter can serve both. Awaited and contained:
   * a reporter that throws cannot replace the build's error.
   */
  onError?: ErrorReporter
}

/**
 * Wraps a route whose construction needs request-time values into a route that builds itself on the
 * first request and reuses that instance thereafter. The build runs where the request-time bindings
 * exist, so the site keeps ownership of where secrets load from — on Cloudflare Workers, `env` only
 * resolves inside the handler (`cloudflare:workers` doesn't resolve at module scope), and this removes
 * the hand-written `let route; route ??= build(env)` singleton from every endpoint:
 *
 * ```ts
 * export const POST = defineLazyRoute(async () => {
 *   const { env } = await import('cloudflare:workers')
 *   return createFormRoute({ schema, ... })
 * })
 * ```
 *
 * The `build` promise (not its resolved route) is memoised, so concurrent first requests share one
 * build rather than racing to construct several. A build that throws is not cached — the next request
 * retries — so a transient failure at construction doesn't wedge the endpoint permanently.
 *
 * Works for any {@link APIRoute}, including {@link createFileRoute}.
 *
 * Pass `onError` to report a failed build: it runs before the route exists, so the route's own `onError`
 * never sees it. Pair it with `requireEnv` so a missing secret is reported by name.
 */
export function defineLazyRoute(build: () => APIRoute | Promise<APIRoute>, options: LazyRouteOptions = {}): APIRoute {
  let cached: Promise<APIRoute> | undefined
  return (context) => {
    const pending = (cached ??= Promise.resolve()
      .then(build)
      .catch(async (error) => {
        // Clear the slot so a construction failure retries on the next request instead of being cached.
        cached = undefined

        try {
          await options.onError?.(error, { stage: 'build' })
        } catch {
          // Nowhere left to report a broken reporter; the build's own error is what the caller must see.
        }
        throw error
      }))
    return pending.then((route) => route(context))
  }
}

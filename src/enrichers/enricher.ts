import { type FormError } from '#errors.js'
import { type FormSubmission } from '#pipeline.js'

/**
 * Everything an enricher may read while acquiring resources for a submission-in-progress. The
 * inspectors have already run, so the submission is trusted.
 */
export interface EnrichmentContext<E extends FormSubmission = FormSubmission> {
  /** The validated submission — pure schema output, a record. Enrichers never mutate it; acquired resources go on the dispatch context, not here. */
  submission: E

  /** The raw form data, for enrichers that read fields the site didn't map (e.g. file inputs). */
  data: FormData

  /** The current request's URL. Its host can be proxy/client-influenced, so prefer `siteURL` for trust decisions. */
  requestURL: URL

  /**
   * The configured site URL (Astro `site`), or `undefined` when unset — the trusted origin (never
   * request-derived). Use it as the base for absolute links; when absent, an enricher needing a base
   * must be given one.
   */
  siteURL?: URL

  /**
   * The instant the submission arrived (stamped once when the request reaches the route), shared by
   * every stage so all rendered output agrees on one time. Do not mutate.
   */
  readonly submittedAt: Date

  /** The client IP when the runtime can resolve it; `undefined` in prerendered/static contexts. */
  clientAddress?: string

  /**
   * Report an operational error to the route's `onError` hook (stage `enrichment`) without
   * failing the request differently. Contained by the route — calling it can never throw.
   */
  report?: (error: unknown) => void
}

/**
 * What an enricher decided:
 *
 * - `{ provide?, rollback? }` — acquisition succeeded. `provide` is the acquired resource (e.g.
 *   `{ files: [...] }`), which the route merges into `context.resources` for the dispatchers — the
 *   submission itself is never mutated, so it stays exactly the schema's validated input. `rollback`
 *   undoes the acquired resource and is invoked, in reverse order across all enrichers, if a later
 *   enricher or the delivery aggregate fails.
 * - `{ reject }` — a clean refusal (e.g. a file failed validation); the client sees the keyed error.
 *
 * `A` is the resource this enricher contributes; the route infers it and hands the dispatchers a
 * `DispatchContext` whose `resources` is the merge of every enricher's `A`.
 */
export type EnrichmentResult<A = object> = { provide?: A; rollback?: () => Promise<void> } | { reject: FormError }

/**
 * A pluggable resource-acquisition step run after the inspectors and before delivery (e.g. moving
 * uploaded files to storage and exposing their links to the dispatchers).
 *
 * Unlike an inspector, an enricher is **fail-closed**: a thrown enricher cannot be skipped —
 * acquisition either completes or the request fails — so the route reports it, rolls back every
 * prior enrichment, and fails. An enricher that wants a clean client refusal returns `{ reject }`.
 *
 * `E` is the submission it reads; `A` is the resource it provides onto `context.resources` (`object` for
 * an enricher that provides nothing typed — the acquisition is purely its rollback-able side effect).
 */
export interface Enricher<E extends FormSubmission = FormSubmission, A = object> {
  /** Acquire resources for the submission: provide the acquired resource and an optional rollback, or `{ reject }`. */
  enrich(submission: E, context: EnrichmentContext<E>): Promise<EnrichmentResult<A>>
}

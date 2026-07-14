import { type FormSubmission } from '#pipeline.js'

/**
 * The request/site context every dispatcher (and its content callbacks) receives — the delivery-stage
 * analogue of the guard/inspection/enrichment contexts. Exposes the two raw URLs so each consumer
 * chooses trusted-vs-display and derives the hostname itself.
 */
export interface DispatchContext<A = object> {
  /** The current request's URL. Its host can be proxy/client-influenced, so prefer `siteURL` for trust decisions. */
  requestURL: URL

  /** The configured site URL (Astro `site`), or `undefined` when unset — the trusted origin (never request-derived). */
  siteURL?: URL

  /**
   * The instant the submission arrived (stamped once when the request reaches the route), shared by
   * every stage so all rendered output agrees on one time. Do not mutate.
   */
  readonly submittedAt: Date

  /** Whether an inspector/guard quarantined this submission (this dispatcher opted in to receive it). */
  quarantined: boolean

  /** Accumulated quarantine reasons (empty when not quarantined or none given). */
  quarantineReasons: readonly string[]

  /**
   * The resources the enrichers acquired for this submission (e.g. `{ files: FileLink[] }` from a
   * `FileUploads` enricher's `attachTo`) — the merge of every enricher's `provide`, `{}` when none.
   * The submission itself carries only the validated input; acquired resources travel here.
   */
  resources: A
}

/**
 * A destination a submission is delivered to (e.g. an email, a chat webhook). All configured
 * dispatchers run in parallel; each decides its own delivery policy from the {@link DispatchContext}.
 *
 * `A` is the resources this destination reads off `context.resources` (`object` when it reads none). The
 * route infers what the enrichers provide and rejects a dispatcher that reads a resource key nothing
 * provides — the reason {@link Dispatcher.dispatch} is a property signature (not a method): it makes
 * TypeScript check `context` contravariantly, which a method's bivariant parameters would not.
 */
export interface Dispatcher<E extends FormSubmission = FormSubmission, A = object> {
  /**
   * Whether this destination receives quarantined submissions. Default false — a quarantined submission
   * (e.g. spam) reaches a destination only by explicit opt-in; set true on an internal/ops destination
   * (an owner notification, a team chat channel) that should see flagged submissions.
   */
  readonly acceptsQuarantined?: boolean

  /** If true, a delivery failure fails the whole submission (→ 502). Default is per-implementation. */
  readonly required?: boolean

  /**
   * Whether this delivery carries the enrichers' acquired resources (e.g. upload links) to a recipient.
   * Files survive if any exposing delivery succeeds, else roll back; set `false` for a notification that
   * doesn't carry them. Default per-implementation — `EmailDispatcher` derives it from its templates
   * (explicit option → the template's `attachments`-derived marker → exposes).
   */
  readonly exposesResources?: boolean

  /**
   * Per-submission opt-out, evaluated by the route before `dispatch`. Return `false` to skip this
   * destination for this submission — a no-op like a quarantine skip: neither a delivery nor a failure,
   * so it never trips the "every attempted delivery failed → 502" rule and never marks resources
   * exposed. Omitted ⇒ always deliver. Use it for conditional delivery, e.g. skip an acknowledgement
   * email when the sender left no address (`deliverWhen: (submission) => Boolean(submission.email)`).
   */
  readonly deliverWhen?: (submission: E, context: DispatchContext<A>) => boolean

  /**
   * Deliver the submission. A throw is a failure; a resolved call is a delivery. Never early-return to
   * skip — that still counts as a send; a quarantined submission (or a `deliverWhen` opt-out) is
   * withheld by the route before `dispatch` is called.
   *
   * A property (function-type) signature, deliberately: it engages `strictFunctionTypes` so a
   * dispatcher reading `context.resources.x` is type-checked against the enrichers that provide it.
   */
  dispatch: (submission: E, context: DispatchContext<A>) => Promise<void>
}

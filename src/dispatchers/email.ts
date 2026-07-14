import { type DispatchContext, type Dispatcher } from '#dispatchers/dispatcher.js'
import { type FormSubmission } from '#pipeline.js'

/** The rendered, per-submission parts of an email — subject and bodies, no addressing. */
export interface EmailContent {
  /** The rendered subject line. */
  subject: string

  /** The rendered plain-text body. */
  text: string

  /** The rendered HTML body. */
  html: string
}

/** A complete outbound email: rendered content plus addressing. */
export interface EmailMessage extends EmailContent {
  /** Sender address. */
  from: string

  /** Recipient address. */
  to: string

  /** Optional `Reply-To` address; omitted from the message when absent. */
  replyTo?: string
}

/**
 * The builders that render a submission into an email's parts. Supplied by a built-in helper like
 * `submissionNotificationTemplates`, or hand-written per site.
 */
export interface EmailTemplates<E extends FormSubmission = FormSubmission, A = object> {
  /** Builds the subject line from the submission and the dispatch context (quarantine disposition, siteURL, requestURL, resources). */
  subject: (submission: E, context: DispatchContext<A>) => string

  /** Builds the plain-text body from the submission and the dispatch context. */
  text: (submission: E, context: DispatchContext<A>) => string

  /** Builds the HTML body from the submission and the dispatch context. */
  html: (submission: E, context: DispatchContext<A>) => string

  /**
   * Set by the built-in factories to signal whether the rendered body includes uploaded-file links;
   * consumed as the default for the dispatcher's `exposesResources`. Hand-written templates omit it.
   */
  readonly exposesResources?: boolean
}

/**
 * Renders a submission into email content using the site's templates.
 *
 * @param templates - The site-owned subject/text/html builders.
 * @param submission - The submission to render.
 * @param context - The dispatch context, passed to every template builder.
 * @returns The rendered email content.
 */
export function renderEmail<E extends FormSubmission, A>(
  templates: EmailTemplates<E, A>,
  submission: E,
  context: DispatchContext<A>
): EmailContent {
  return {
    subject: templates.subject(submission, context),
    text: templates.text(submission, context),
    html: templates.html(submission, context)
  }
}

/**
 * A mail-provider adapter: pure API mapping, no rendering, no delivery policy.
 * Implement this to add a provider (Postmark, Resend, SES, …) — {@link EmailDispatcher} stays unchanged.
 */
export interface EmailTransport {
  /**
   * Delivers a complete email message.
   *
   * @param message - The message to deliver, including addressing and rendered content.
   * @throws On transport failure — the dispatcher lets this propagate as a delivery failure.
   */
  deliver(message: EmailMessage): Promise<void>
}

/** An email address, either fixed or resolved per submission (e.g. `(submission) => submission.email`). */
export type AddressInput<E extends FormSubmission = FormSubmission> = string | ((submission: E) => string)

/** Like {@link AddressInput}, but may resolve to `undefined` to omit the header — for optional addresses like `Reply-To`. */
export type OptionalAddressInput<E extends FormSubmission = FormSubmission> =
  string | ((submission: E) => string | undefined)

/** Options for constructing an {@link EmailDispatcher}. */
export interface EmailDispatcherOptions<E extends FormSubmission = FormSubmission, A = object> {
  /** The provider adapter that puts the message on the wire. */
  transport: EmailTransport

  /** Site-owned subject/text/html builders. Its resource reads (`A`) are inferred from here. */
  templates: EmailTemplates<E, A>

  /** Sender address — a fixed string, or a function of the submission. */
  from: AddressInput<E>

  /** Recipient address — a fixed string, or a function of the submission (e.g. to acknowledge the sender). */
  to: AddressInput<E>

  /**
   * Optional `Reply-To` — a fixed string, or a function of the submission (e.g. `(submission) =>
   * submission.email` so a reply reaches the sender). Return `undefined` to omit the header.
   */
  replyTo?: OptionalAddressInput<E>

  /**
   * Whether this email receives quarantined submissions. Default false — a spam-flagged submission is
   * withheld from customer/owner email unless you opt in; set true on an internal ops mailbox.
   */
  acceptsQuarantined?: boolean

  /** Whether a delivery failure fails the whole submission. Default `true` — email is usually load-bearing. */
  required?: boolean

  /**
   * Whether this email carries the upload links. Resolution: explicit value → the templates' own marker
   * (the built-in factories set it from whether they render an `attachments` field) → `true` for
   * hand-written templates. See {@link Dispatcher.exposesResources}.
   */
  exposesResources?: boolean

  /**
   * Per-submission opt-out — return `false` to skip this email for a submission (a no-op, not a
   * failure). E.g. an acknowledgement addressed to the sender: `deliverWhen: (submission) =>
   * Boolean(submission.email)`. See {@link Dispatcher.deliverWhen}.
   */
  deliverWhen?: (submission: E, context: DispatchContext<A>) => boolean
}

/**
 * Emails each submission using site-owned templates and a pluggable provider transport.
 *
 * Owns everything email-generic — rendering, addressing, delivery policy — and delegates only the
 * wire call to its {@link EmailTransport}, so swapping providers never touches templates or config.
 */
export class EmailDispatcher<E extends FormSubmission = FormSubmission, A = object> implements Dispatcher<E, A> {
  // MARK: - Object Lifecycle

  /**
   * Creates an email dispatcher for a given transport, templates, and addressing.
   *
   * @param options - The dispatcher options, including the transport, templates, addresses, and policy.
   */
  constructor(private readonly options: EmailDispatcherOptions<E, A>) {}

  // MARK: - Dispatcher API

  get acceptsQuarantined(): boolean {
    return this.options.acceptsQuarantined ?? false
  }

  get required(): boolean {
    return this.options.required ?? true
  }

  /**
   * Resolves the rollback marker: an explicit constructor option wins; else the templates' own marker
   * (the built-in factories set it from whether they render an `attachments` field); else `true`, the
   * safe default for hand-written templates that render upload links.
   */
  get exposesResources(): boolean {
    return this.options.exposesResources ?? this.options.templates.exposesResources ?? true
  }

  get deliverWhen(): EmailDispatcherOptions<E, A>['deliverWhen'] {
    return this.options.deliverWhen
  }

  /**
   * Renders the submission through the templates and hands the message to the transport.
   *
   * @param submission - The submission to email.
   * @param context - The dispatch context, threaded into the templates so computed field values can be resolved.
   */
  async dispatch(submission: E, context: DispatchContext<A>): Promise<void> {
    const content = renderEmail(this.options.templates, submission, context)
    const resolveAddress = (address: OptionalAddressInput<E>): string | undefined =>
      typeof address === 'function' ? address(submission) : address

    const replyTo = this.options.replyTo === undefined ? undefined : resolveAddress(this.options.replyTo)
    await this.options.transport.deliver({
      ...content,
      from: resolveAddress(this.options.from)!,
      to: resolveAddress(this.options.to)!,
      // Omit the header entirely when the reply-to resolves empty, rather than sending a blank one.
      ...(replyTo ? { replyTo } : {})
    })
  }
}

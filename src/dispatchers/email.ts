import type { DispatchContext, Dispatcher } from '#dispatchers/dispatcher.js'
import { EmailRecipientError } from '#dispatchers/email-recipient-error.js'
import type { AttachedFile } from '#enrichers/index.js'
import type { FormSubmission } from '#pipeline.js'

/** The rendered, per-submission parts of an email — subject and bodies, no addressing. */
export interface EmailContent {
  /** The rendered subject line. */
  subject: string

  /** The rendered plain-text body. */
  text: string

  /** The rendered HTML body. */
  html: string
}

/** A file sent inside an email, as a transport hands it to its provider. */
export interface EmailAttachment {
  /** The filename the recipient sees, ending in the extension of the type the file's bytes matched. */
  filename: string

  /** The content type the file's bytes matched, never the sender's claim. */
  contentType: string

  /** The file's bytes. */
  content: Uint8Array
}

/** A complete outbound email: rendered content plus addressing. */
export interface EmailMessage extends EmailContent {
  /** Sender address. */
  from: string

  /** Recipient address. */
  to: string

  /** Optional `Reply-To` address; omitted from the message when absent. */
  replyTo?: string

  /**
   * Files sent inside the email, in the order the form posted them. Present only when the dispatcher's `attach`
   * key holds at least one file, so a message without any is exactly the message it would be without `attach`.
   */
  attachments?: EmailAttachment[]
}

/**
 * The keys of a resources type `A` that hold files an email can attach (an {@link AttachedFile} list, as a
 * `FileAttachments` enricher provides), never `FileLink`s or anything else. These are the keys an
 * {@link EmailDispatcher}'s `attach` option can name for a route whose enrichers provide `A`.
 */
export type AttachableKey<A> = { [K in keyof A]: A[K] extends readonly AttachedFile[] ? K : never }[keyof A] & string

/**
 * The resources an email attaching key `K` reads: that key's attachable files. `Record<never, …>` is `{}`, so an
 * email that attaches nothing reads nothing more than its templates do.
 */
type AttachedResources<K extends string> = Record<K, readonly AttachedFile[]>

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
 * Runs of control characters, any of which could end a header line in a transport that writes raw headers. The
 * C1 range counts too, since some software reads U+0085 (next line) as a line break.
 */
const CONTROL_CHARACTERS = /\p{Cc}+/gu

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
    // A subject can interpolate sender-typed fields, and a line break in a header lets a transport that writes
    // raw headers be told to add more, so every control character becomes a space.
    subject: templates.subject(submission, context).replace(CONTROL_CHARACTERS, ' '),
    text: templates.text(submission, context),
    html: templates.html(submission, context)
  }
}

/** A quoted display name, whose `\"` escapes stay inside it. */
const QUOTED_STRING = /"(?:[^"\\]|\\.)*"/g

/**
 * Whether a resolved address names one recipient and holds no control character that could end a header line.
 * Outside a quoted display name (`"Lovelace, Ada" <…>`), a comma or semicolon separates recipients, and a
 * second `@` is a second address that a lenient parser could split off.
 */
function isSingleAddress(address: string): boolean {
  const unquoted = address.replace(QUOTED_STRING, '')
  return !/\p{Cc}/u.test(address) && !/[,;]/.test(unquoted) && unquoted.split('@').length <= 2
}

/**
 * A mail-provider adapter: pure API mapping, no rendering, no delivery policy.
 * Implement this to add a provider (Postmark, Resend, SES, …) — {@link EmailDispatcher} stays unchanged.
 */
export interface EmailTransport {
  /**
   * Delivers a complete email message.
   *
   * @param message - The message to deliver, including addressing, rendered content and any attachments, which a
   * transport must send rather than drop.
   * @throws On transport failure — the dispatcher lets this propagate as a delivery failure.
   */
  deliver(message: EmailMessage): Promise<void>
}

/** An email address, either fixed or resolved per submission (e.g. `(submission) => submission.email`). */
export type AddressInput<E extends FormSubmission = FormSubmission> = string | ((submission: E) => string)

/** Like {@link AddressInput}, but may resolve to `undefined` to omit the header — for optional addresses like `Reply-To`. */
export type OptionalAddressInput<E extends FormSubmission = FormSubmission> =
  string | ((submission: E) => string | undefined)

/**
 * Options for constructing an {@link EmailDispatcher}. `A` is what the templates read off `context.resources`, and
 * `K` the key the email attaches files from; both are inferred.
 */
export interface EmailDispatcherOptions<
  E extends FormSubmission = FormSubmission,
  A = object,
  K extends string = never
> {
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
   * The `context.resources` key whose files this email carries as attachments, such as the `attachTo` of a
   * `FileAttachments` enricher. The route refuses, at compile time, a key no enricher provides or one that holds
   * links rather than attachable files (see {@link AttachableKey}). Omitted, the email attaches nothing.
   *
   * Never attach to an address the sender typed (a `to` that returns `submission.email`, say): the files would go
   * wherever they point it, from your sender. A `to` resolved on the server, such as a tracking address looked up
   * from a job id, is fine. Attaching leaves `exposesResources` alone, since the files are never stored.
   */
  attach?: K

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
export class EmailDispatcher<
  E extends FormSubmission = FormSubmission,
  A = object,
  K extends string = never
> implements Dispatcher<E, A & AttachedResources<K>> {
  // MARK: - Object Lifecycle

  /**
   * Creates an email dispatcher for a given transport, templates, and addressing.
   *
   * @param options - The dispatcher options, including the transport, templates, addresses, and policy.
   */
  constructor(private readonly options: EmailDispatcherOptions<E, A, K>) {}

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
   * safe default for hand-written templates that render upload links. `attach` plays no part: attached files
   * are held in memory, so there is nothing to keep for them.
   */
  get exposesResources(): boolean {
    return this.options.exposesResources ?? this.options.templates.exposesResources ?? true
  }

  get deliverWhen(): EmailDispatcherOptions<E, A, K>['deliverWhen'] {
    return this.options.deliverWhen
  }

  /**
   * Renders the submission through the templates, reads the `attach` key's files, and hands the message to the
   * transport.
   *
   * @param submission - The submission to email.
   * @param context - The dispatch context, threaded into the templates so computed field values can be resolved.
   * @throws {EmailRecipientError} When a `to` or `replyTo` function returns more than one address, or a control
   * character.
   */
  async dispatch(submission: E, context: DispatchContext<A & AttachedResources<K>>): Promise<void> {
    const { from, to, replyTo } = this.options
    const recipient = typeof to === 'function' ? to(submission) : to
    if (typeof to === 'function' && !isSingleAddress(recipient)) throw new EmailRecipientError('to')

    const resolvedReplyTo = typeof replyTo === 'function' ? replyTo(submission) : replyTo
    if (typeof replyTo === 'function' && resolvedReplyTo && !isSingleAddress(resolvedReplyTo)) {
      throw new EmailRecipientError('replyTo')
    }

    // A resolved sender can carry the visitor's name, so it loses control characters as the subject does.
    const sender = typeof from === 'function' ? from(submission).replace(CONTROL_CHARACTERS, ' ') : from

    const content = renderEmail<E, A>(this.options.templates, submission, context)
    const attachments = await this.attachments(context.resources)
    await this.options.transport.deliver({
      ...content,
      from: sender,
      to: recipient,

      // Omit the header entirely when the reply-to resolves empty, rather than sending a blank one.
      ...(resolvedReplyTo ? { replyTo: resolvedReplyTo } : {}),
      ...(attachments.length > 0 ? { attachments } : {})
    })
  }

  // MARK: - Attachments

  /**
   * Reads the `attach` key's files into attachments, or none when the email attaches nothing.
   *
   * @param resources - The resources the enrichers provided.
   * @returns The attachments, in the order the files were provided.
   */
  private async attachments(resources: AttachedResources<K>): Promise<EmailAttachment[]> {
    const { attach } = this.options
    if (attach === undefined) return []

    // `FileAttachments` provides nothing for an empty field, so the typed key can still be absent.
    const files: readonly AttachedFile[] | undefined = resources[attach]
    if (files === undefined) return []

    return Promise.all(
      files.map(async (file) => ({ filename: file.name, contentType: file.contentType, content: await file.bytes() }))
    )
  }
}

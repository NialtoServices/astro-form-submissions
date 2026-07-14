import { type DispatchContext } from '#dispatchers/dispatcher.js'
import {
  DEFAULT_ATTACHMENTS_LABEL,
  displayHost,
  displayURL,
  formatSubmittedAt,
  resolveAttachments,
  type EmailTemplateCopy
} from '#dispatchers/email-view.js'
import { type EmailTemplates } from '#dispatchers/email.js'
import { resolveFields, type FieldInput } from '#dispatchers/fields.js'
import { mustacheTemplates } from '#dispatchers/mustache.js'
import { htmlSource, textSource } from '#dispatchers/submission-acknowledgement-sources.js'
import { type FileLink } from '#enrichers/index.js'
import { type FormSubmission } from '#pipeline.js'

const SUBJECT_SOURCE = "We've received your submission"

const DEFAULT_EYEBROW = 'Thank you'
const DEFAULT_HEADING = "We've received your submission"
const DEFAULT_MESSAGE = "Thanks for getting in touch. We've received your submission and will be in touch soon."
const DEFAULT_FOOTER_TEXT = "This is an automated acknowledgement; you don't need to reply."

/**
 * Contact details shown in the acknowledgement card so the recipient can reach a human. Every line
 * is optional and **omitted by default** — the whole block disappears when none are given.
 */
export interface AcknowledgementContact {
  /** A reply/contact email, rendered as a `mailto:` link. */
  email?: string

  /** A phone number. */
  phone?: string

  /** A postal/physical address. */
  address?: string
}

/** Options for {@link submissionAcknowledgementTemplates}. */
export interface SubmissionAcknowledgementTemplatesOptions<
  E extends FormSubmission = FormSubmission,
  K extends string = never
> {
  /**
   * Which submission fields to echo back to the sender, in order — same spec as
   * `submissionNotificationTemplates`' `fields`: bare keys are humanised, empty values dropped.
   * **Optional**: omit it (or pass `[]`) for a plain "thanks" acknowledgement with no copied fields.
   */
  fields?: FieldInput<E>[]

  /**
   * Human name of the form (e.g. `Contact form`), shown in the meta line and the subject. Optional —
   * the title is always the thank-you heading, so omitting it just drops the form name from the meta.
   */
  formName?: string

  /** Site/brand wordmark shown above the card; omitted entirely when unset. */
  brandName?: string

  /**
   * A greeting line shown above the message (e.g. `(submission) => \`Hi ${submission.name},\``).
   * Field names are site-specific, so there's no default — omitted unless you provide one.
   */
  greeting?: (submission: E) => string | undefined

  /**
   * The confirmation message shown above the copied fields — a string, or a function of the
   * submission. Defaults to a generic "we've received it and will be in touch" line.
   */
  message?: string | ((submission: E) => string | undefined)

  /**
   * Produces the timestamp shown in the meta line. Defaults to the submission's shared arrival instant
   * (`context.submittedAt`) formatted in UTC (e.g. `13 Jul 2026, 15:58 UTC`); return `undefined` to omit
   * the timestamp. Receives the dispatch context, so a custom formatter can read that shared instant.
   */
  submittedAt?: (submission: E, context: DispatchContext) => string | undefined

  /**
   * Mustache source overriding the subject line, rendered against the submission (plus the resolved
   * view values). Default: `We've received your submission`.
   */
  subject?: string

  /**
   * The `context.resources` key holding uploaded-file links — a `FileLink[]` a `FileUploads` enricher
   * exposed via its `attachTo` (default `files`). Rendered as a list after the fields; omitted when
   * empty. Naming it makes this email *require* that resource: the route rejects the config if no
   * enricher provides the key.
   */
  attachments?: K

  /**
   * Contact details rendered in the card (reply email, phone, postal address). Omitted entirely
   * unless provided — see {@link AcknowledgementContact}.
   */
  contact?: AcknowledgementContact

  /**
   * Overrides for the template's fixed UI copy (eyebrow, title, footer, section labels) — pass a
   * translated/reworded set to reuse the same HTML shell in another language. Unset fields fall back
   * to the English defaults. The per-submission `greeting` and `message` above cover the body copy.
   */
  copy?: EmailTemplateCopy
}

/**
 * A ready-made acknowledgement email for **the person who submitted the form** — a warm confirmation
 * with a copy of what they sent. Pair it with a second {@link EmailDispatcher} whose `to` resolves to
 * the sender's address (e.g. `to: (submission) => submission.email`), typically `required: false` so a
 * failed courtesy email never fails the submission. For the email to your own inbox, see
 * {@link submissionNotificationTemplates}.
 *
 * The footer links the site URL (the dispatch context's `siteURL`, else its `requestURL`).
 */
export function submissionAcknowledgementTemplates<
  E extends FormSubmission = FormSubmission,
  const K extends string = never
>(
  options: SubmissionAcknowledgementTemplatesOptions<E, K>
): EmailTemplates<E, [K] extends [never] ? object : Record<K, FileLink[]>> {
  return {
    // Marks whether the rendered body links uploaded files, so the dispatcher can default its rollback flag.
    exposesResources: options.attachments != null,
    ...mustacheTemplates<E, [K] extends [never] ? object : Record<K, FileLink[]>>({
      subject: options.subject ?? SUBJECT_SOURCE,
      text: textSource,
      html: htmlSource,
      view: (submission, context) => {
        const siteHost = displayHost(context)
        const siteURL = displayURL(context)

        // Reading a generic conditional bag by a generic key needs an assertion; `resolveAttachments`
        // validates the value, and the key is the config-owned `attachments`, never user input.
        const resources = context.resources as Record<string, unknown>
        const attachmentItems = options.attachments ? resolveAttachments(resources[options.attachments]) : undefined
        const message = typeof options.message === 'function' ? options.message(submission) : options.message
        const copy = options.copy ?? {}
        const contact = options.contact ?? {}

        // Computed field `value` functions receive the dispatch context (see {@link resolveFields}); an empty list
        // renders a plain "thanks" with no copied-submission block.
        const fields = resolveFields(options.fields ?? [], submission, context)
        return {
          ...submission,

          fields,
          hasFields: fields.length > 0,

          // Drives the contact block's own top spacer, needed only when no field/attachment rows precede it.
          hasBodyItems: fields.length > 0 || attachmentItems !== undefined,

          // Wrapped as `{ items }` so the attachments heading renders once above the list.
          attachments: attachmentItems && { items: attachmentItems },
          siteHost: siteHost !== '' ? siteHost : undefined,
          siteURL: siteURL !== '' ? siteURL : undefined,
          formName: options.formName,
          brandName: options.brandName,
          eyebrow: copy.eyebrow ?? DEFAULT_EYEBROW,
          heading: copy.heading ?? DEFAULT_HEADING,
          attachmentsLabel: copy.attachmentsLabel ?? DEFAULT_ATTACHMENTS_LABEL,
          footerText: copy.footerText ?? DEFAULT_FOOTER_TEXT,
          contactEmail: contact.email,
          contactPhone: contact.phone,

          // A tel: URI omits visual separators, so the link target keeps only digits and a leading `+`.
          contactPhoneHref: contact.phone?.replace(/[^\d+]/g, ''),
          contactAddress: contact.address,
          hasContact: Boolean(contact.email || contact.phone || contact.address),
          greeting: options.greeting?.(submission),
          message: message ?? DEFAULT_MESSAGE,
          submittedAt: options.submittedAt
            ? options.submittedAt(submission, context)
            : formatSubmittedAt(context.submittedAt)
        }
      }
    })
  }
}

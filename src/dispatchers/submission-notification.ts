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
import { htmlSource, textSource } from '#dispatchers/submission-notification-sources.js'
import { type FileLink } from '#enrichers/index.js'
import { type FormSubmission } from '#pipeline.js'

const SUBJECT_SOURCE =
  'New form submission{{#formName}}: {{formName}}{{/formName}}{{#siteHost}} via {{siteHost}}{{/siteHost}}'

const DEFAULT_EYEBROW = 'New submission'
const DEFAULT_HEADING = 'New form submission'
const DEFAULT_FOOTER_TEXT = 'This is an automated notification from your website form.'

/** Options for {@link submissionNotificationTemplates}. */
export interface SubmissionNotificationTemplatesOptions<
  E extends FormSubmission = FormSubmission,
  K extends string = never
> {
  /**
   * Which submission fields appear, in order — a {@link FieldInput} list ({@link FieldSpec} or bare key):
   * bare keys are humanised (`preferredTime` → "Preferred Time"), empty values dropped. Required: the
   * field set is site-specific, so the caller declares it.
   */
  fields: FieldInput<E>[]

  /**
   * Human name of the form (e.g. `Contact form`), shown as the email's title and in the subject,
   * preview, and text header. Without one, the templates fall back to a generic heading.
   */
  formName?: string

  /** Site/brand wordmark shown above the card; omitted entirely when unset. */
  brandName?: string

  /**
   * Produces the timestamp shown in the meta line. Defaults to the submission's shared arrival instant
   * (`context.submittedAt`) formatted in UTC (e.g. `13 Jul 2026, 15:58 UTC`); return `undefined` to omit
   * it. The dispatch context is passed so a custom formatter can reuse that instant.
   */
  submittedAt?: (submission: E, context: DispatchContext) => string | undefined

  /**
   * Mustache source overriding the subject line, rendered against the submission (plus the
   * resolved `fields`/`siteHost`/`formName` view values) — e.g. `'New enquiry from {{name}}'`.
   * Default: `New form submission: <formName> via <siteHost>`, with each part omitted when absent.
   */
  subject?: string

  /**
   * The `context.resources` key holding uploaded-file links — a `FileLink[]` a `FileUploads` enricher
   * exposed via its `attachTo` (default `files`). Rendered as a list of download links after the
   * fields; omitted when empty. Naming it makes this email *require* that resource: the route rejects
   * the config if no enricher provides the key.
   */
  attachments?: K

  /**
   * Overrides for the template's fixed UI copy (eyebrow, title, footer, section labels) — pass a
   * translated/reworded set to reuse the same HTML shell in another language. Unset fields fall back
   * to the English defaults.
   */
  copy?: EmailTemplateCopy
}

/**
 * A ready-made generic submission email for **the site's own inbox** — declare the field list and
 * compose a form without writing any template files. The copy is deliberately plain (labelled field
 * blocks with line breaks preserved); sites wanting their own voice graduate to {@link mustacheTemplates}
 * or hand-written {@link EmailTemplates} functions without touching the dispatcher. To acknowledge the
 * person who submitted, see {@link submissionAcknowledgementTemplates}.
 *
 * The subject mentions the site host and the footer links the site URL, both taken from the dispatch
 * context (`siteURL ?? requestURL`).
 */
export function submissionNotificationTemplates<
  E extends FormSubmission = FormSubmission,
  const K extends string = never
>(
  options: SubmissionNotificationTemplatesOptions<E, K>
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
        const copy = options.copy ?? {}
        return {
          ...submission,

          // Computed field `value` functions receive the dispatch context (see {@link resolveFields}).
          fields: resolveFields(options.fields, submission, context),

          // Wrapped as `{ items }` so the attachments heading renders once above the list.
          attachments: attachmentItems && { items: attachmentItems },
          siteHost: siteHost !== '' ? siteHost : undefined,
          siteURL: siteURL !== '' ? siteURL : undefined,
          formName: options.formName,
          brandName: options.brandName,
          eyebrow: copy.eyebrow ?? DEFAULT_EYEBROW,
          heading: copy.heading ?? options.formName ?? DEFAULT_HEADING,
          attachmentsLabel: copy.attachmentsLabel ?? DEFAULT_ATTACHMENTS_LABEL,
          footerText: copy.footerText ?? DEFAULT_FOOTER_TEXT,
          submittedAt: options.submittedAt
            ? options.submittedAt(submission, context)
            : formatSubmittedAt(context.submittedAt)
        }
      }
    })
  }
}

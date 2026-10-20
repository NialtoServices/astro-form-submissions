import { formatFileSize } from '#client/file-size.js'
import type { DispatchContext } from '#dispatchers/dispatcher.js'
import { isRecord } from '#type-guards.js'

/** Rendering helpers shared by the built-in {@link submissionNotificationTemplates} and
 * {@link submissionAcknowledgementTemplates} views. */

/**
 * The host the built-in email copy shows in "via …" (subject, preview, meta line): the configured site's
 * host, or `undefined` without Astro `site`. Never the request host, which some adapters take from a header
 * the sender sets, and the acknowledgement goes to an address the sender chose.
 */
export function displayHost(context: DispatchContext): string | undefined {
  return context.siteURL?.hostname || undefined
}

/**
 * The site URL the built-in email footers link to (e.g. `https://example.com/`): the configured site reduced
 * to its root, or `undefined` without Astro `site`, for the same reason as {@link displayHost}.
 */
export function displayURL(context: DispatchContext): string | undefined {
  return context.siteURL && new URL('/', context.siteURL).href
}

/**
 * The fixed UI copy baked into the built-in email templates — override any of these to translate or
 * reword the email while keeping the same HTML shell. Every field is optional; unset ones fall back
 * to each template's English default.
 */
export interface EmailTemplateCopy {
  /** The small uppercase label above the title (e.g. "New submission" / "Thank you"). */
  eyebrow?: string

  /** The email's title — the card heading and the `<title>`. */
  heading?: string

  /** The "Attachments" section heading. */
  attachmentsLabel?: string

  /** The automated-notice sentence in the footer. */
  footerText?: string
}

/** Default attachments section heading, shared by both built-in templates. */
export const DEFAULT_ATTACHMENTS_LABEL = 'Attachments'

/** One rendered attachment link in a built-in email view; `name`, `url`, and `size` render HTML-escaped. */
interface AttachmentView {
  /** The attachment's display name. */
  name: string

  /** The attachment's download URL. */
  url: string

  /**
   * The attachment's human-readable size (e.g. `2.5 MB`), or `''` when the source has no usable size.
   * Always present: Mustache resolves a missing key against the enclosing view, so an absent `size`
   * would render the submission's own `size` field instead.
   */
  size: string
}

/** Accepts only well-formed `http:`/`https:` links, so a hostile `javascript:`/`data:` url is dropped. */
function isSafeURL(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Normalises an acquired attachments resource (`context.resources[attachTo]`) to an `AttachmentView[]`,
 * or `undefined` when empty/absent. A link with a missing or unsafe (non-http) url is dropped — the
 * templates escape every field, so a hostile filename or url can neither break the `href` attribute nor
 * smuggle an executable scheme.
 */
export function resolveAttachments(value: unknown): AttachmentView[] | undefined {
  if (!Array.isArray(value)) return undefined

  const links = value.flatMap((entry): AttachmentView[] => {
    if (!isRecord(entry)) return []

    const { name, url, size } = entry
    if (typeof name !== 'string' || typeof url !== 'string' || !isSafeURL(url)) return []

    return [{ name, url, size: typeof size === 'number' ? formatFileSize(size) : '' }]
  })

  return links.length > 0 ? links : undefined
}

/** The default `submittedAt`: the submission's shared arrival instant, formatted unambiguously in UTC. */
export function formatSubmittedAt(submittedAt: Date): string {
  const formatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
  return `${formatter.format(submittedAt)} UTC`
}

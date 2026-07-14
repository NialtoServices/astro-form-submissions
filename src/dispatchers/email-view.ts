import { type DispatchContext } from '#dispatchers/dispatcher.js'
import { formatFileSize } from '#strings.js'
import { isRecord } from '#type-guards.js'

/** Rendering helpers shared by the built-in {@link submissionNotificationTemplates} and
 * {@link submissionAcknowledgementTemplates} views. */

/**
 * The host the built-in email copy shows in "via …" (subject, preview, meta line): the configured site's
 * host when Astro `site` is set, else the request host. A view decides its own fallback; this is the display one.
 */
export function displayHost(context: DispatchContext): string {
  return (context.siteURL ?? context.requestURL).hostname
}

/**
 * The full site URL the built-in email footers link to (e.g. `https://example.com/`): the configured site
 * when Astro `site` is set, else the request origin, always reduced to the root — never a request path.
 */
export function displayURL(context: DispatchContext): string {
  return new URL('/', context.siteURL ?? context.requestURL).href
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
export interface AttachmentView {
  /** The attachment's display name. */
  name: string

  /** The attachment's download URL. */
  url: string

  /** The attachment's human-readable size (e.g. `2.5 MB`), absent when the source has no usable size. */
  size?: string
}

/** Accepts only well-formed `http:`/`https:` links, so a hostile `javascript:`/`data:` url is dropped. */
function isSafeUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Normalises an acquired attachments resource (`context.resources[attachTo]`) to a `{ name, url }[]`,
 * or `undefined` when empty/absent. A link with a missing or unsafe (non-http) url is dropped — the
 * templates escape both fields, so a hostile filename or url can neither break the `href` attribute nor
 * smuggle an executable scheme.
 */
export function resolveAttachments(value: unknown): AttachmentView[] | undefined {
  if (!Array.isArray(value)) return undefined

  const links = value.flatMap((entry): AttachmentView[] => {
    if (!isRecord(entry)) return []

    const { name, url, size } = entry
    if (typeof name !== 'string' || typeof url !== 'string' || !isSafeUrl(url)) return []

    const formattedSize = typeof size === 'number' ? formatFileSize(size) : ''
    return [formattedSize ? { name, url, size: formattedSize } : { name, url }]
  })

  return links.length > 0 ? links : undefined
}

/** The default `submittedAt`: the submission's shared arrival instant, formatted unambiguously in UTC. */
export function formatSubmittedAt(submittedAt: Date): string {
  const formatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
  return `${formatter.format(submittedAt)} UTC`
}

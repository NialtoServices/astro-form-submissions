import { type DispatchContext } from '#dispatchers/dispatcher.js'
import { type EmailTemplates } from '#dispatchers/email.js'
import { type FormSubmission } from '#pipeline.js'
import Mustache from 'mustache'

/** Options for {@link mustacheTemplates}. */
export interface MustacheTemplatesOptions<E extends FormSubmission = FormSubmission, A = object> {
  /** Mustache source for the subject line. Rendered as plain text — no HTML escaping. */
  subject: string

  /**
   * Mustache source for the plain-text body (typically a `<name>.txt.mustache` file imported
   * with Vite's `?raw`). Rendered as plain text — no HTML escaping.
   */
  text: string

  /**
   * Mustache source for the HTML body (typically a `<name>.html.mustache` file imported with
   * Vite's `?raw`). `{{value}}` interpolations are HTML-escaped; `{{{value}}}` passes through raw.
   */
  html: string

  /**
   * Optional transform for computed presentation values the submission doesn't carry (Mustache is
   * logic-less — formatting belongs here). Also gets the dispatch context (including `resources`).
   * Defaults to rendering the submission itself.
   */
  view?: (submission: E, context: DispatchContext<A>) => Record<string, unknown>
}

/**
 * Builds {@link EmailTemplates} from Mustache sources, Rails-mailer style: keep the copy in
 * `<name>.html.mustache` / `<name>.txt.mustache` files beside the route (imported with `?raw`)
 * and let the engine handle interpolation, optional `{{#section}}`s, and HTML escaping.
 *
 * Mustache is interpreted — no `eval`/`new Function` — so it runs on workerd, where compiling
 * engines (Handlebars, EJS) cannot. Sites wanting a different engine implement
 * {@link EmailTemplates}'s three functions with it instead; the dispatcher never knows.
 */
export function mustacheTemplates<E extends FormSubmission = FormSubmission, A = object>(
  options: MustacheTemplatesOptions<E, A>
): EmailTemplates<E, A> {
  const view = options.view ?? ((submission: E) => submission)
  return {
    subject: (submission, context) => renderPlain(options.subject, view(submission, context)),
    text: (submission, context) => renderPlain(options.text, view(submission, context)),
    html: (submission, context) =>
      Mustache.render(options.html, view(submission, context), undefined, { escape: escapeHtml })
  }
}

/** Render without HTML escaping — subjects and text bodies are not HTML documents. */
function renderPlain(template: string, view: unknown): string {
  return Mustache.render(template, view, undefined, { escape: (value: unknown) => String(value) })
}

/**
 * Escapes an interpolation for the html body. Neutralises the characters that could break out of an
 * element or a quoted attribute, but leaves `/` intact (it needs no escaping in HTML) so URLs render
 * legibly rather than as `&#x2F;` runs — Mustache's default escape would mangle every slash.
 */
function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

import { DestinationUnreachableError, isGatewayFailure } from '#dispatchers/destination-unreachable-error.js'
import { DiscordDeliveryError } from '#dispatchers/discord-delivery-error.js'
import type { DispatchContext, Dispatcher } from '#dispatchers/dispatcher.js'
import { resolveField, type FieldSpec } from '#dispatchers/fields.js'
import type { FormSubmission } from '#pipeline.js'
import { clamp } from '#strings.js'

/**
 * Discord's embed limits. Exceeding any one rejects the whole embed with a 400, so every user-controlled component is
 * clamped instead.
 * => https://discord.com/developers/docs/resources/message#embed-object-embed-limits
 */
const TITLE_LIMIT = 256
const DESCRIPTION_LIMIT = 4096
const FIELDS_LIMIT = 25
const FIELD_NAME_LIMIT = 256
const FIELD_VALUE_LIMIT = 1024
const EMBED_TOTAL_LIMIT = 6000

/** Characters Discord reads in embed text as formatting, headings, quotes, masked links or mentions. */
const MARKDOWN_CHARACTERS = /[\\*_~`|>#\-[\]()<@]/g

/**
 * A bare http(s) URL, which Discord links as written, so escaping inside it would break the link. Brackets,
 * parentheses and the formatting characters end it, so a masked link built around one is still escaped.
 */
const BARE_URL = /https?:\/\/[^\s<>()[\]`|*~]+/g

/**
 * Escapes text so Discord shows it as written: no formatting, headings, masked links (`[text](url)`) or
 * mentions. Bare URLs are left as they are, so they still link. The dispatcher applies it to every value it
 * resolves from `fields` specs and keys; use it on submission text that a `title`, `description` or `fields`
 * builder of your own puts in the embed.
 *
 * @param text - The text to show literally.
 * @returns The text with each markdown character outside a bare URL backslash-escaped.
 */
export function escapeDiscordMarkdown(text: string): string {
  const escape = (segment: string) => segment.replace(MARKDOWN_CHARACTERS, '\\$&')

  let escaped = ''
  let segmentStart = 0
  for (const url of text.matchAll(BARE_URL)) {
    escaped += escape(text.slice(segmentStart, url.index)) + url[0]
    segmentStart = url.index + url[0].length
  }

  return escaped + escape(text.slice(segmentStart))
}

const DISCORD_TIMEOUT_MS = 5000

const DEFAULT_EMBED_COLOR = 0xffde00
const DEFAULT_TITLE = 'New form submission'

/** The embed payload posted to the webhook. `description` is omitted when the site provides none. */
interface DiscordEmbed {
  /** The embed title. */
  title: string

  /** The embed description; omitted when the site provides none. */
  description?: string

  /** The embed's fields (label/value pairs). */
  fields: DiscordField[]

  /** The embed accent colour, as an integer. */
  color: number
}

/**
 * A single field in a Discord embed.
 */
export interface DiscordField {
  /** The field label. Must be non-empty, or the whole embed is rejected. */
  name: string

  /** The field value. Must be non-empty, or the whole embed is rejected. */
  value: string

  /** Whether the field should be displayed inline. Discord treats an omitted value as `false`. */
  inline?: boolean
}

/**
 * Declarative description of one embed field: the shared {@link FieldSpec} plus Discord's inline-rendering flag.
 */
export interface DiscordFieldSpec<E extends FormSubmission = FormSubmission> extends FieldSpec<E> {
  /** Render side-by-side with adjacent fields. Defaults to `true` when resolved from a spec. */
  inline?: boolean
}

/** A bare submission key is shorthand for `{ key }`. */
export type DiscordFieldInput<E extends FormSubmission = FormSubmission> = (keyof E & string) | DiscordFieldSpec<E>

/** The webhook a {@link DiscordDispatcher} posts to. */
export interface DiscordWebhook {
  /** The URL of the Discord webhook to send messages to. */
  webhookURL: string
}

/** Options for constructing a {@link DiscordDispatcher}, besides its {@link DiscordWebhook}. */
export interface DiscordDispatcherSettings<E extends FormSubmission = FormSubmission> {
  /** Embed title. Defaults to a generic label; build one from the site's own fields or the context to customise. */
  title?: (submission: E, context: DispatchContext) => string

  /**
   * Optional embed description (e.g. a free-text `message` field the site pulls off the submission). Posted
   * as markdown, so pass submission text through {@link escapeDiscordMarkdown}.
   */
  description?: (submission: E, context: DispatchContext) => string | undefined

  /**
   * Which embed fields to show, in order — bare submission keys, specs (for labels / computed values),
   * or a builder function; `[]` for a title/description-only embed. Required: the field set is
   * site-specific, so the caller declares it rather than the integration guessing.
   */
  fields: DiscordFieldInput<E>[] | ((submission: E, context: DispatchContext) => DiscordField[])

  /** Embed accent colour as an integer. Defaults to {@link DEFAULT_EMBED_COLOR}. */
  color?: number

  /**
   * Whether values resolved from `fields` keys and specs are escaped with {@link escapeDiscordMarkdown}, so a
   * submission can't put formatting, masked links or mentions in the channel. Default `true`; set `false` only
   * when every such value is markdown you wrote. A `fields` builder's values are posted as given.
   */
  escapeMarkdown?: boolean

  /** The name a failed post to this webhook is reported under, such as `team-chat`. See {@link Dispatcher.name}. */
  name?: string

  /**
   * Whether this webhook receives quarantined submissions. Default false; set true on an ops channel
   * that should still be pinged about flagged (e.g. spam) submissions.
   */
  acceptsQuarantined?: boolean

  /** Whether a delivery failure fails the whole submission. Default `false` — notifications are usually best-effort. */
  required?: boolean

  /**
   * Whether the embed carries the upload links. Default `false` (a ping isn't where uploads are fetched); `true` if it
   * links them. See {@link Dispatcher.exposesResources}.
   */
  exposesResources?: boolean

  /**
   * Per-submission opt-out — return `false` to skip this webhook for a submission (a no-op, not a
   * failure), e.g. to ping only enquiries meeting some condition. See {@link Dispatcher.deliverWhen}.
   */
  deliverWhen?: (submission: E, context: DispatchContext) => boolean
}

/** Options for constructing a {@link DiscordDispatcher}. */
export type DiscordDispatcherOptions<E extends FormSubmission = FormSubmission> = DiscordDispatcherSettings<E> &
  DiscordWebhook

/**
 * Posts a copy of a form submission to a Discord webhook as an embed.
 *
 * Construct once with the webhook URL (and optional per-site presentation),
 * then call `dispatch` for each submission.
 */
export class DiscordDispatcher<E extends FormSubmission = FormSubmission> implements Dispatcher<E> {
  private readonly webhookURL: string

  // MARK: - Object Lifecycle

  /**
   * Creates a Discord dispatcher for a given webhook URL and optional per-site presentation.
   *
   * @param options - The Discord dispatcher options, including the webhook URL, title, description, fields, and color.
   */
  constructor(private readonly options: DiscordDispatcherOptions<E>) {
    // Checked here, so a malformed URL fails the build rather than every send, where it would read as an
    // outage and `fetch`'s error would quote the URL, token included. The message never echoes the value.
    const { webhookURL } = options
    if (typeof webhookURL !== 'string' || !URL.canParse(webhookURL) || new URL(webhookURL).protocol !== 'https:') {
      throw new Error('DiscordDispatcher needs `webhookURL` to be an absolute https URL.')
    }

    this.webhookURL = webhookURL
  }

  // MARK: - Dispatcher API

  get name(): string | undefined {
    return this.options.name
  }

  get acceptsQuarantined(): boolean {
    return this.options.acceptsQuarantined ?? false
  }

  get required(): boolean {
    return this.options.required ?? false
  }

  get exposesResources(): boolean {
    return this.options.exposesResources ?? false
  }

  get deliverWhen(): DiscordDispatcherOptions<E>['deliverWhen'] {
    return this.options.deliverWhen
  }

  /**
   * Sends a form submission to the configured Discord webhook.
   *
   * @param submission - The submission to send.
   * @param context - The dispatch context, made available to every content callback.
   */
  async dispatch(submission: E, context: DispatchContext): Promise<void> {
    const title = clamp(this.options.title ? this.options.title(submission, context) : DEFAULT_TITLE, TITLE_LIMIT)
    const fields = this.resolveFields(submission, context)

    // Discord also rejects any embed whose title + fields + description exceeds 6000 chars total; per-component clamps
    // alone allow ~32000, so fields are bounded against what the title leaves and trailing ones dropped on overflow.
    let budget = EMBED_TOTAL_LIMIT - title.length
    const bounded: DiscordField[] = []
    for (const field of fields) {
      const length = field.name.length + field.value.length
      if (length > budget) break

      bounded.push(field)
      budget -= length
    }

    const embed: DiscordEmbed = { title, fields: bounded, color: this.options.color ?? DEFAULT_EMBED_COLOR }

    const rawDescription = this.options.description?.(submission, context)
    if (rawDescription) {
      const description = clamp(rawDescription, Math.min(DESCRIPTION_LIMIT, budget))
      if (description) embed.description = description
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS)
    let response: Response

    try {
      response = await fetch(this.webhookURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },

        // Mentions in an embed never notify; this keeps any mention inert even if the payload ever carries `content`.
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
        signal: controller.signal
      })
    } catch (error) {
      throw new DestinationUnreachableError('Discord', { cause: error })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const refused = new DiscordDeliveryError(response.status)
      if (isGatewayFailure(response.status)) throw new DestinationUnreachableError('Discord', { cause: refused })

      throw refused
    }
  }

  // MARK: - Embeds

  /**
   * Resolves the embed fields for a given submission, clamping each to Discord's limits and dropping any empty ones.
   *
   * @param submission - The submission to resolve fields for.
   * @param context - The dispatch context, passed to computed values and builder functions.
   * @returns The resolved embed fields, clamped to Discord's limits and with empty ones dropped.
   */
  private resolveFields(submission: E, context: DispatchContext): DiscordField[] {
    if (typeof this.options.fields === 'function') {
      // Discord rejects the whole embed for an empty field name or value; drop those rather than lose the notification.
      return this.options
        .fields(submission, context)
        .filter((field) => field.name !== '' && field.value !== '')
        .slice(0, FIELDS_LIMIT)
        .map((field) => ({
          ...field,
          name: clamp(field.name, FIELD_NAME_LIMIT),
          value: clamp(field.value, FIELD_VALUE_LIMIT)
        }))
    }

    const fields: DiscordField[] = []
    for (const input of this.options.fields) {
      if (fields.length >= FIELDS_LIMIT) break

      const resolved = resolveField(input, submission, context)
      if (!resolved) continue

      const inline = typeof input === 'string' ? true : (input.inline ?? true)
      const value = (this.options.escapeMarkdown ?? true) ? escapeDiscordMarkdown(resolved.value) : resolved.value
      fields.push({
        name: clamp(resolved.label, FIELD_NAME_LIMIT),
        value: clamp(value, FIELD_VALUE_LIMIT),
        inline
      })
    }

    return fields
  }
}

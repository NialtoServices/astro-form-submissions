import { encodeBase64 } from '#dispatchers/base64.js'
import { DestinationUnreachableError, isGatewayFailure } from '#dispatchers/destination-unreachable-error.js'
import type { EmailMessage, EmailTransport } from '#dispatchers/email.js'
import { PostmarkDeliveryError } from '#dispatchers/postmark-delivery-error.js'
import { assertPositiveNumberOption } from '#numeric-options.js'
import { OperationalError } from '#operational-error.js'

/** Postmark's single-message send endpoint. */
const POSTMARK_EMAIL_URL = 'https://api.postmarkapp.com/email'

/**
 * The most bytes Postmark accepts in one message, attachments included and measured after base64, as its "Send a
 * single email" guide states (10 MB). Read as 10,000,000 bytes, the smaller of the two meanings of "MB", so a
 * message under it is under the limit either way.
 */
export const POSTMARK_MAX_MESSAGE_BYTES = 10_000_000

/** Options for constructing a {@link PostmarkTransport}. */
export interface PostmarkTransportOptions {
  /** Postmark server token. */
  token: string

  /** Message stream to send via. Default `outbound`. */
  messageStream?: string

  /** Send timeout in seconds. Default `10`. */
  timeoutSeconds?: number
}

/**
 * Delivers email via the Postmark API. Pure API mapping — rendering, addressing, and delivery
 * policy live on the {@link EmailDispatcher} this transport is plugged into.
 *
 * It calls the API with the runtime's own `fetch` and sets nothing beyond the method, headers and body. Cloudflare
 * Workers refuses request options it does not support, such as the `cache: 'default'` an HTTP client library may
 * add, before the request is sent, so a client between this transport and `fetch` can break every send.
 */
export class PostmarkTransport implements EmailTransport {
  // MARK: - Object Lifecycle

  /**
   * Creates a Postmark transport for a given server token.
   *
   * @param options - The transport options, including the token, message stream, and timeout.
   */
  constructor(private readonly options: PostmarkTransportOptions) {
    // A timer fires at once past 2^31 - 1 ms, which would abort every send.
    assertPositiveNumberOption('PostmarkTransport `timeoutSeconds`', options.timeoutSeconds, { maximum: 2_147_483 })
  }

  // MARK: - Transport API

  /**
   * Sends the message through Postmark. Errors propagate to the dispatcher.
   *
   * @param message - The complete email message to deliver.
   * @throws {OperationalError} With code `postmark.message-too-large` when the message, attachments included,
   * is over {@link POSTMARK_MAX_MESSAGE_BYTES}. Postmark is not called, so this is a definite failure.
   * @throws {PostmarkDeliveryError} When Postmark refuses the message.
   * @throws {DestinationUnreachableError} When Postmark can't be reached or doesn't answer in time.
   */
  async deliver(message: EmailMessage): Promise<void> {
    const body = JSON.stringify({
      From: message.from,
      To: message.to,
      ReplyTo: message.replyTo,
      Subject: message.subject,
      TextBody: message.text,
      HtmlBody: message.html,
      MessageStream: this.options.messageStream || 'outbound',
      ...(message.attachments?.length
        ? {
            Attachments: message.attachments.map((attachment) => ({
              Name: attachment.filename,
              Content: encodeBase64(attachment.content),
              ContentType: attachment.contentType
            }))
          }
        : {})
    })

    const bytes = new TextEncoder().encode(body).length
    if (bytes > POSTMARK_MAX_MESSAGE_BYTES) {
      throw new OperationalError(
        'postmark.message-too-large',
        `The message is ${bytes} bytes, over the ${POSTMARK_MAX_MESSAGE_BYTES} Postmark accepts once attachments are base64 encoded, so it was not sent.`,
        { details: { bytes, limit: POSTMARK_MAX_MESSAGE_BYTES } }
      )
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), (this.options.timeoutSeconds ?? 10) * 1000)
    let response: Response
    let refusal: PostmarkRefusal | undefined

    try {
      response = await fetch(POSTMARK_EMAIL_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.options.token
        },
        body,
        signal: controller.signal
      })

      // The timeout also bounds the error body, so a refusal whose body stalls can't hang the delivery.
      if (!response.ok) refusal = await readRefusal(response)
    } catch (error) {
      throw new DestinationUnreachableError('Postmark', { cause: error })
    } finally {
      clearTimeout(timeout)
    }

    if (response.ok) return

    const refused = new PostmarkDeliveryError(response.status, refusal?.ErrorCode, refusal?.Message)
    if (isGatewayFailure(response.status)) throw new DestinationUnreachableError('Postmark', { cause: refused })

    throw refused
  }
}

/** Postmark's explanation of a refused message, as its error responses carry it. */
interface PostmarkRefusal {
  ErrorCode?: number
  Message?: string
}

/**
 * Reads Postmark's explanation from an error response, or nothing when the body is not Postmark's JSON, as with an
 * outage page served by something in front of the API.
 *
 * @param response - The error response.
 * @returns The error code and message Postmark gave, if any.
 */
async function readRefusal(response: Response): Promise<PostmarkRefusal | undefined> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return undefined

    const { ErrorCode, Message } = body as Record<string, unknown>
    return {
      ErrorCode: typeof ErrorCode === 'number' ? ErrorCode : undefined,
      Message: typeof Message === 'string' ? Message : undefined
    }
  } catch {
    return undefined
  }
}

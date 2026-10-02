import { DestinationUnreachableError } from '#dispatchers/destination-unreachable-error.js'
import type { EmailMessage, EmailTransport } from '#dispatchers/email.js'

/** Postmark's single-message send endpoint. */
const POSTMARK_EMAIL_URL = 'https://api.postmarkapp.com/email'

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
 * A message Postmark refused. Carries the HTTP `status` and, when Postmark explains the refusal, its own
 * `errorCode` (an inactive recipient, an unconfirmed sender signature, a bad token), so an operator can tell a
 * problem with the address from one with the account. The message quotes Postmark's explanation, which can name
 * an address, so it reaches only an operator's reporter and never the sender.
 */
export class PostmarkDeliveryError extends Error {
  // MARK: - Object Lifecycle

  constructor(
    readonly status: number,
    readonly errorCode?: number,
    readonly postmarkMessage?: string
  ) {
    const detail = errorCode === undefined ? `HTTP ${status}` : `HTTP ${status}, error ${errorCode}`
    super(`Postmark refused the message (${detail})${postmarkMessage ? `: ${postmarkMessage}` : ''}`)
    this.name = 'PostmarkDeliveryError'
  }

  // MARK: - Reporting

  /**
   * Postmark's refusal code under the conventional `code` name, which the default reporter logs. Postmark
   * answers 422 for nearly every refusal, so the status alone can't tell an inactive recipient from a bad
   * sender signature.
   */
  get code(): number | undefined {
    return this.errorCode
  }
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
  constructor(private readonly options: PostmarkTransportOptions) {}

  // MARK: - Transport API

  /**
   * Sends the message through Postmark. Errors propagate to the dispatcher.
   *
   * @param message - The complete email message to deliver.
   * @throws {PostmarkDeliveryError} When Postmark refuses the message.
   * @throws {DestinationUnreachableError} When Postmark can't be reached or doesn't answer in time.
   */
  async deliver(message: EmailMessage): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), (this.options.timeoutSeconds ?? 10) * 1000)
    let response: Response

    try {
      response = await fetch(POSTMARK_EMAIL_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.options.token
        },
        body: JSON.stringify({
          From: message.from,
          To: message.to,
          ReplyTo: message.replyTo,
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html,
          MessageStream: this.options.messageStream || 'outbound'
        }),
        signal: controller.signal
      })
    } catch (error) {
      throw new DestinationUnreachableError('Postmark', { cause: error })
    } finally {
      clearTimeout(timeout)
    }

    if (response.ok) return

    const refusal = await readRefusal(response)
    throw new PostmarkDeliveryError(response.status, refusal?.ErrorCode, refusal?.Message)
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

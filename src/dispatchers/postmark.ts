import { type EmailMessage, type EmailTransport } from '#dispatchers/email.js'
import { ServerClient } from 'postmark'

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
 */
export class PostmarkTransport implements EmailTransport {
  // MARK: - Object Lifecycle

  private readonly client: ServerClient

  /**
   * Creates a Postmark transport for a given server token.
   *
   * @param options - The transport options, including the token, message stream, and timeout.
   */
  constructor(private readonly options: PostmarkTransportOptions) {
    this.client = new ServerClient(options.token, { timeout: options.timeoutSeconds ?? 10 })
  }

  // MARK: - Transport API

  /**
   * Sends the message through Postmark. Errors propagate to the dispatcher.
   *
   * @param message - The complete email message to deliver.
   */
  async deliver(message: EmailMessage): Promise<void> {
    await this.client.sendEmail({
      From: message.from,
      To: message.to,
      ReplyTo: message.replyTo,
      Subject: message.subject,
      TextBody: message.text,
      HtmlBody: message.html,
      MessageStream: this.options.messageStream || 'outbound'
    })
  }
}

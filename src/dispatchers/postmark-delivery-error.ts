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

/**
 * An address resolved from a submission named more than one address, or held a control character. A `to` or
 * `replyTo` function reads sender-typed data, so a list there would let one submission email many people from
 * the site's sender, and a line break could add headers of its own on a transport that writes raw headers; a
 * fixed string may still list several of the site's own inboxes. Never carries the address itself, which is
 * submission data.
 */
export class EmailRecipientError extends Error {
  // MARK: - Object Lifecycle

  constructor(readonly field: 'to' | 'replyTo' = 'to') {
    super(
      `A \`${field}\` resolver must return a single address, but returned one containing "," or ";" or a control character.`
    )
    this.name = 'EmailRecipientError'
  }
}

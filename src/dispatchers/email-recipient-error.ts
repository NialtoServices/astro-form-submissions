/**
 * An address resolved from a submission wasn't one plain address, bare (`local@domain`) or as `Name <local@domain>`.
 * A `to` or `replyTo` function reads sender-typed data, so a list there, or any other shape some mail parser could
 * split into one (a comment, a group, a quoted local part, an encoded word), would let one submission email many
 * people from the site's sender, and a line break could add headers of its own on a transport that writes raw
 * headers; a fixed string may still list several of the site's own inboxes. Never carries the address itself,
 * which is submission data.
 */
export class EmailRecipientError extends Error {
  // MARK: - Object Lifecycle

  constructor(readonly field: 'to' | 'replyTo' = 'to') {
    super(
      `A \`${field}\` resolver must return one plain address, bare or as \`Name <address>\`; the one it returned ` +
        'takes some other shape or holds a control character.'
    )
    this.name = 'EmailRecipientError'
  }
}

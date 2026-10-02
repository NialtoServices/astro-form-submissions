/**
 * A recipient resolved from a submission named more than one address. A `to` function reads
 * sender-typed data, so a list there would let one submission email many people from the site's sender;
 * a fixed `to` string may still list several of the site's own inboxes. Never carries the address itself,
 * which is submission data.
 */
export class EmailRecipientError extends Error {
  // MARK: - Object Lifecycle

  constructor() {
    super('A `to` resolver must return a single address, but returned one containing "," or ";".')
    this.name = 'EmailRecipientError'
  }
}

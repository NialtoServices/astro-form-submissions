/**
 * A failure the toolkit noticed and handled itself: a limiter outage it failed open on, a Siteverify outage it
 * failed closed on, an uploaded object it could not delete. Its `code` names the failure in the default
 * reporter's line; the message explains it in full for a site's own reporter.
 */
export class OperationalError extends Error {
  // MARK: - Object Lifecycle

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'OperationalError'
  }
}

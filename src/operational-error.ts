import type { VerdictDetails } from '#pipeline.js'

/** Options for an {@link OperationalError}: the standard `cause`, plus details that locate the failure. */
export interface OperationalErrorOptions extends ErrorOptions {
  /** Identifiers that locate the failure, such as the keys of objects left behind. */
  details?: VerdictDetails
}

/**
 * A failure the toolkit noticed and handled itself: a limiter outage it failed open on, a Siteverify outage it
 * failed closed on, an uploaded object it could not delete. Its `code` and `details` name the failure in the
 * default reporter's line; the message explains it in full for a site's own reporter.
 */
export class OperationalError extends Error {
  /** Identifiers that locate the failure; the default reporter prints those that look like identifiers. */
  readonly details?: VerdictDetails

  // MARK: - Object Lifecycle

  constructor(
    readonly code: string,
    message: string,
    options?: OperationalErrorOptions
  ) {
    super(message, options)
    this.name = 'OperationalError'
    this.details = options?.details
  }
}

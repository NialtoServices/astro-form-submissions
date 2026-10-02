/**
 * A delivery that never got a response: the request to a dispatcher's destination failed (DNS, TLS, a
 * dropped connection) or timed out. Names the destination (`Postmark`, `Discord`) so a site with several
 * dispatchers can tell which one failed, and keeps the underlying failure as `cause` (an `AbortError` for a
 * timeout). Never carries a URL or token.
 */
export class DestinationUnreachableError extends Error {
  // MARK: - Object Lifecycle

  constructor(
    readonly destination: string,
    options: { cause: unknown }
  ) {
    super(`${destination} could not be reached`, options)
    this.name = 'DestinationUnreachableError'
  }
}

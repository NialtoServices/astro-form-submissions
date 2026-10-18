/**
 * Whether a status is a gateway's own failure (502, 504): something in front of the destination lost or gave up
 * on its answer, so the destination may have acted on the request regardless.
 *
 * @param status - The HTTP status received.
 * @returns `true` for 502 and 504.
 */
export function isGatewayFailure(status: number): boolean {
  return status === 502 || status === 504
}

/**
 * A delivery whose outcome is unknown: the request to a dispatcher's destination failed (DNS, TLS, a dropped
 * connection), timed out, or met a gateway failure ({@link isGatewayFailure}), so it may or may not have
 * arrived. Names the destination (`Postmark`, `Discord`) so a site with several dispatchers can tell which one
 * failed, and keeps the underlying failure as `cause` (an `AbortError` for a timeout, the destination's own
 * delivery error for a gateway status). Never carries a URL or token.
 */
export class DestinationUnreachableError extends Error {
  // MARK: - Object Lifecycle

  constructor(
    readonly destination: string,
    options: { cause: unknown }
  ) {
    super(`${destination} could not be reached.`, options)
    this.name = 'DestinationUnreachableError'
  }
}

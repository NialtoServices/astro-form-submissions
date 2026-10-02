/**
 * A Discord webhook delivery failure. Carries the HTTP `status` as a property (so the route's PII-safe reporter can
 * log `status=…` and operators can tell a revoked webhook from rate-limiting or an outage), but never the webhook URL
 * or response body.
 */
export class DiscordDeliveryError extends Error {
  // MARK: - Object Lifecycle

  constructor(readonly status: number) {
    super(`Discord webhook responded with ${status}`)
    this.name = 'DiscordDeliveryError'
  }
}

import type { DispatchContext } from '#dispatchers/dispatcher.js'

/**
 * A {@link DispatchContext} fixture for dispatcher/template unit tests. `host` sets both the request
 * and site URLs to `https://<host>/` (so the display host resolves to `<host>`); pass `siteURL: null`
 * to model an unconfigured Astro `site` (only the request host available). `quarantined` /
 * `quarantineReasons` model the disposition an inspector or guard would have set.
 */
export function dispatchContext<A = object>({
  host = 'example.com',
  siteURL,
  submittedAt = new Date('2026-01-02T03:04:05Z'),
  quarantined = false,
  quarantineReasons = [],
  resources = {} as A
}: {
  host?: string
  siteURL?: URL | null
  submittedAt?: Date
  quarantined?: boolean
  quarantineReasons?: readonly string[]
  resources?: A
} = {}): DispatchContext<A> {
  const requestURL = new URL(`https://${host}/`)
  return {
    requestURL,
    siteURL: siteURL === null ? undefined : (siteURL ?? requestURL),
    submittedAt,
    quarantined,
    quarantineReasons,
    resources
  }
}

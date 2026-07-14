import { formError } from '#errors.js'
import { type InspectionContext, type Inspector } from '#inspectors/inspector.js'
import { type FormSubmission, type Verdict } from '#pipeline.js'
import { isRecord } from '#type-guards.js'

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TURNSTILE_TIMEOUT_MS = 5000

/**
 * Siteverify error codes worth an operator's attention (our configuration or Cloudflare itself). Token-level codes
 * (`invalid-input-response`, `timeout-or-duplicate`, etc) are expected sender behaviour and stay silent.
 */
const OPERATIONAL_ERROR_CODES = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
  'internal-error'
])

/**
 * Response from the Cloudflare Turnstile siteverify endpoint.
 */
interface SiteVerifyResponse {
  /** Whether the token was valid. */
  success: boolean

  /** Error codes returned by the siteverify endpoint, if any. */
  'error-codes'?: string[]

  /** The hostname the token was solved on. */
  hostname?: string
}

/**
 * Narrows a parsed siteverify body to a {@link SiteVerifyResponse}. Only `success` must be a literal boolean —
 * a truthy non-boolean (e.g. `"false"`) signals a contract change and must not pass. The optional `hostname` and
 * `error-codes` are validated where they are read, so a wrong-typed one is tolerated here.
 */
function isSiteVerifyResponse(value: unknown): value is SiteVerifyResponse {
  return isRecord(value) && typeof value.success === 'boolean'
}

/** The verification outcome, with an operational failure category when one occurred. */
interface VerifyResult {
  /** Whether the token passed verification — `false` for expected token invalidity and operational failures alike. */
  success: boolean

  /** The hostname the token was solved on, when Siteverify reports one. */
  hostname?: string

  /**
   * A sanitised description of an operational failure (outage, misconfiguration, contract change) — never set for
   * expected token invalidity, and never carrying the token or secret.
   */
  failure?: string
}

/**
 * Canonicalises a hostname for comparison — DNS names are case-insensitive, and URL parsing lowercases ASCII hosts.
 * Returns `undefined` when the value is not purely a hostname (a port, path, or credentials is misconfiguration, not
 * something to silently strip).
 */
function canonicalHostname(value: string): string | undefined {
  try {
    const url = new URL(`https://${value}`)
    return url.hostname && url.href === `https://${url.hostname}/` ? url.hostname : undefined
  } catch {
    return undefined
  }
}

/** Options for constructing a {@link TurnstileInspector}. */
export interface TurnstileInspectorOptions {
  /** The Turnstile secret key used for server-side verification. */
  secretKey: string

  /** Form field carrying the Turnstile response token. Default `cf-turnstile-response`. */
  tokenField?: string

  /**
   * Bind tokens to the hostname(s) they were solved on — opt-in defence-in-depth against replay from
   * the public sitekey (the widget's allowed-domains config is the primary control):
   *
   * - `false` / omitted (**default**) — off.
   * - `true` — verify against Astro `site` (reject + report if `site` is unset; never the request host).
   * - a `string` — verify against exactly that host.
   * - a `string[]` — accept any listed host (e.g. production + a `*.workers.dev` preview); a malformed
   *   entry is a reported misconfig, and a literal `[]` rejects everything (reported once).
   */
  verifyHostname?: boolean | string | string[]

  /**
   * Whether to send the visitor's IP to Cloudflare Siteverify as `remoteip` when Astro exposes a client
   * address. It slightly sharpens bot detection but is a personal-data transfer to Cloudflare. Default
   * `true`; set `false` to withhold it — Siteverify still verifies the token without it.
   */
  sendRemoteIP?: boolean
}

/**
 * Verifies a Cloudflare Turnstile token against the `siteverify` endpoint.
 *
 * Fail-closed: any verification failure (missing token, network error, timeout, non-2xx, unparseable body, hostname
 * mismatch) rejects the submission.
 *
 * Never throws: errors are caught internally so the route's fail-open handling of unexpected inspector errors can't
 * accidentally bypass verification. Operational failures (outage, bad secret, contract change) are surfaced through
 * `context.report` so a total form outage is diagnosable, while the sender still sees the generic rejection.
 */
export class TurnstileInspector implements Inspector {
  /** Errors this inspector rejects with. Override the copy per-site via `errors[key]`. */
  static readonly errors = {
    verification: formError('verification', 400, 'Verification failed. Please try again.')
  }

  // A `[]` allowlist rejects every submission, so its diagnostic is reported once rather than per request.
  private emptyAllowlistReported = false

  // MARK: - Object Lifecycle

  /**
   * Creates a Turnstile inspector for a given secret key.
   *
   * @param options - The inspector options, including the secret key, token field, and hostname policy.
   */
  constructor(private readonly options: TurnstileInspectorOptions) {}

  // MARK: - Inspector API

  /**
   * Verifies the submission's Turnstile token.
   *
   * @param context - The inspection context; reads the token from `data` and binds against the trusted hostname.
   * @returns A `verification` rejection on any failure, otherwise `{ action: 'accept' }`.
   */
  async inspect(context: InspectionContext<FormSubmission>): Promise<Verdict> {
    const tokenField = this.options.tokenField ?? 'cf-turnstile-response'
    const verifyHostname = this.options.verifyHostname ?? false
    const token = `${context.data.get(tokenField) ?? ''}`

    // A missing token is expected sender/bot behaviour, not an operational event — no report.
    if (!token) return { action: 'reject', error: TurnstileInspector.errors.verification }

    // `remoteip` is optional to Siteverify and a personal-data transfer, so it's gated by `sendRemoteIP`.
    const sendRemoteIP = this.options.sendRemoteIP ?? true
    const result = await this.verify(token, sendRemoteIP ? context.clientAddress : undefined)
    if (result.failure) {
      context.report?.(new Error(`Turnstile verification could not complete: ${result.failure}`))
    }

    if (!result.success) return { action: 'reject', error: TurnstileInspector.errors.verification }

    if (verifyHostname !== false) {
      // `true` binds to the configured Astro `site`; a string/array is the allowlist itself.
      const configured = verifyHostname === true ? context.siteURL?.hostname : verifyHostname
      const trustedHostnames = configured === undefined ? [] : Array.isArray(configured) ? configured : [configured]
      if (trustedHostnames.length === 0) {
        if (Array.isArray(configured)) {
          // Report the accidental `[]` once so it stays traceable without flooding the logs.
          if (!this.emptyAllowlistReported) {
            this.emptyAllowlistReported = true
            context.report?.(
              new Error(
                'Turnstile verifyHostname is an empty allowlist ([]) — every submission is rejected. ' +
                  'Pass a hostname, `true` to bind to Astro `site`, or `false` to disable.'
              )
            )
          }
        } else {
          // Enabled but no configured `site`: fail closed rather than bind to a request-derived host that a
          // spoofed Host header could choose.
          context.report?.(
            new Error(
              'Turnstile hostname verification is enabled but no trusted hostname is configured. ' +
                'Set `verifyHostname` to a hostname or Astro `site`, or disable via `verifyHostname: false`.'
            )
          )
        }

        return { action: 'reject', error: TurnstileInspector.errors.verification }
      }

      // Canonicalise both sides: DNS names are case-insensitive and neither side is guaranteed lowercase.
      // An un-canonicalisable entry is a misconfiguration to surface, not skip.
      const expectedHostnames = new Set<string>()
      for (const candidate of trustedHostnames) {
        const expectedHostname = canonicalHostname(candidate)
        if (!expectedHostname) {
          context.report?.(
            new Error(
              `Turnstile hostname verification is misconfigured: ${JSON.stringify(candidate)} is not a valid hostname.`
            )
          )

          return { action: 'reject', error: TurnstileInspector.errors.verification }
        }

        expectedHostnames.add(expectedHostname)
      }

      const solvedHostname = result.hostname === undefined ? undefined : canonicalHostname(result.hostname)
      if (solvedHostname === undefined || !expectedHostnames.has(solvedHostname)) {
        return { action: 'reject', error: TurnstileInspector.errors.verification }
      }
    }

    return { action: 'accept' }
  }

  // MARK: - Turnstile API

  /**
   * Verifies the provided Turnstile token with the Cloudflare `siteverify` endpoint.
   *
   * @param token - The Turnstile response token from the form (non-empty; the caller rejects blanks).
   * @param remoteIP - The client IP, when known.
   * @returns The verification outcome, the solved hostname, and any operational failure category.
   */
  private async verify(token: string, remoteIP?: string): Promise<VerifyResult> {
    const requestBody = new FormData()
    requestBody.set('secret', this.options.secretKey)
    requestBody.set('response', token)
    if (remoteIP) requestBody.set('remoteip', remoteIP)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS)
    let responseData: unknown

    try {
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body: requestBody,
        signal: controller.signal
      })

      if (!response.ok) return { success: false, failure: `siteverify responded with status ${response.status}` }

      // Read the body inside the try so the abort timeout also bounds a response that returns headers then stalls.
      responseData = await response.json().catch(() => undefined)
    } catch {
      return { success: false, failure: 'siteverify was unreachable or timed out' }
    } finally {
      clearTimeout(timeout)
    }

    if (!isSiteVerifyResponse(responseData)) {
      return { success: false, failure: 'siteverify returned an invalid response body' }
    }

    const verification = responseData

    if (!verification.success) {
      const errorCodes = Array.isArray(verification['error-codes']) ? verification['error-codes'] : []
      const operational = errorCodes.filter((code) => OPERATIONAL_ERROR_CODES.has(code))
      if (operational.length > 0) {
        return { success: false, failure: `siteverify reported: ${operational.join(', ')}` }
      }

      return { success: false }
    }

    return { success: true, hostname: typeof verification.hostname === 'string' ? verification.hostname : undefined }
  }
}

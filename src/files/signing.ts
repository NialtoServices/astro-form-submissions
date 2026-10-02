// Tamper-proof download tokens for uploaded files stored behind a signed link.
//
// A compact HS256 JWT minted/verified with Web Crypto (no dependency). The token is **opaque**: it
// carries only the storage object key and an `exp` expiry — never the filename or content-type, which
// are personal/descriptive and a JWT body is merely base64url (decodable by anyone holding the URL).
// Display metadata is read back from storage at download time. `exp` bounds a link's lifetime
// independently of storage; rotating the secret invalidates every issued link at once.

import type { EnrichmentContext } from '#enrichers/enricher.js'
import type { FormSubmission } from '#pipeline.js'
import { assertValidSigningSecret, signClaims, tokenToPathSegment, verifyClaims } from '#tokens.js'

/** Default link lifetime — 7 days. */
const DEFAULT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60

/** The opaque claims a signed file token carries: the object to fetch and when the link expires. */
export interface FileToken {
  /** The storage object key the token grants access to. */
  objectKey: string

  /** Expiry as a Unix timestamp in **seconds**; a token is rejected once this passes. */
  exp: number
}

/** The stored-file descriptor a link builder receives (for a custom builder that wants the name/type). */
export interface FilePayload {
  /** The storage object key. */
  objectKey: string

  /** The stored file's original filename. */
  filename: string

  /** The stored file's sniffed content-type. */
  contentType: string
}

/**
 * Signs a file token into a compact HS256 token.
 *
 * @param token - The object key and expiry to embed.
 * @param secret - The HMAC signing secret.
 * @returns The signed token (base64url header.body.signature).
 */
export function signFileToken(token: FileToken, secret: string): Promise<string> {
  return signClaims({ objectKey: token.objectKey, exp: token.exp }, secret)
}

/**
 * Verifies a signed file token and returns its claims, or `null` if invalid, tampered, or expired.
 *
 * @param token - The token to verify.
 * @param secret - The HMAC signing secret.
 * @returns The claims when the signature and schema are valid and the token is unexpired, otherwise `null`.
 */
export async function verifyFileToken(token: string, secret: string): Promise<FileToken | null> {
  const claims = await verifyClaims(token, secret)

  // Download tokens are the only kind issued without a `use` claim (links already in inboxes predate
  // it), so a receipt or an upload grant, which carry one, can never stand in for a download link.
  if (!claims || 'use' in claims || typeof claims.objectKey !== 'string') return null

  return { objectKey: claims.objectKey, exp: claims.exp as number }
}

/** Options for {@link signedLink}. */
export interface SignedLinkOptions {
  /**
   * The HMAC signing secret (also required by the matching {@link createFileRoute}). Must be at least
   * 32 characters — a short secret is brute-forceable and rejected at construction.
   */
  secret: string

  /**
   * The trusted public base the download link is absolute against (e.g. `https://example.com`).
   * Defaults to Astro `site`; **one of the two is required** — the request host is never used (it could
   * place a valid token inside an attacker-origin link), so link building fails closed without it.
   */
  baseURL?: string | URL

  /** Path prefix the download route is mounted at. Default `/files`. */
  basePath?: string

  /**
   * Link lifetime in seconds. Default 7 days; must be a finite positive number when given. Keep the
   * storage lifecycle rule at least this long (so a valid link's object still exists); shorten it to
   * limit how long a leaked bearer link stays usable.
   */
  ttlSeconds?: number
}

/**
 * Builds the `link` function {@link FileUploads} needs: turns a stored object into an absolute,
 * signed download URL. The token's `.` separators are swapped to `~` so the URL survives
 * `trailingSlash: 'always'` (a dot in the final path segment 404s — Astro #16140); the matching
 * {@link createFileRoute} swaps them back.
 *
 * Fails closed (throws) when no trusted base is available — set Astro `site` or the `baseURL` option.
 *
 * @param options - The signing secret, trusted base URL, and optional base path.
 * @returns An async link builder for {@link FileUploadsOptions.link}.
 */
export function signedLink<E extends FormSubmission = FormSubmission>(
  options: SignedLinkOptions
): (stored: FilePayload, context: EnrichmentContext<E>) => Promise<string> {
  assertValidSigningSecret(options.secret)

  const basePath = (options.basePath ?? '/files').replace(/\/+$/, '')
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_LINK_TTL_SECONDS
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('signedLink `ttlSeconds` must be a finite positive number.')
  }

  return async (stored, context) => {
    const base = options.baseURL ?? context.siteURL
    if (!base) {
      throw new Error(
        'signedLink has no trusted base URL — set the `baseURL` option or Astro `site`. ' +
          'The request host is deliberately not used, since it can be spoofed on some adapters.'
      )
    }

    const exp = Math.floor(Date.now() / 1000) + ttlSeconds
    const token = tokenToPathSegment(await signFileToken({ objectKey: stored.objectKey, exp }, options.secret))

    return new URL(`${basePath}/${token}/`, base).toString()
  }
}

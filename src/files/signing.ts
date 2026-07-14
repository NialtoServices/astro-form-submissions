// Tamper-proof download tokens for uploaded files stored behind a signed link.
//
// A compact HS256 JWT minted/verified with Web Crypto (no dependency). The token is **opaque**: it
// carries only the storage object key and an `exp` expiry — never the filename or content-type, which
// are personal/descriptive and a JWT body is merely base64url (decodable by anyone holding the URL).
// Display metadata is read back from storage at download time. `exp` bounds a link's lifetime
// independently of storage; rotating the secret invalidates every issued link at once.

import { type EnrichmentContext } from '#enrichers/enricher.js'
import { type FormSubmission } from '#pipeline.js'
import { isRecord } from '#type-guards.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Default link lifetime — 7 days. */
const DEFAULT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Minimum accepted signing-secret length. HS256's security rests entirely on the secret's entropy, so
 * a short secret (an empty string, a `"secret"` placeholder) is brute-forceable and forges any token.
 * This is a floor against obviously-weak inputs, not a substitute for a high-entropy random secret.
 */
const MIN_SECRET_LENGTH = 32

/**
 * Fail fast on a signing secret too short to be safe for HS256. Both {@link signedLink} and
 * {@link createFileRoute} run this at construction, so a misconfiguration surfaces at startup rather
 * than minting forgeable links (or silently accepting forged ones) at request time.
 */
export function assertValidSigningSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Signing secret must be at least ${MIN_SECRET_LENGTH} characters.`)
  }
}

/** Narrows a parsed token body to {@link FileToken} claims: a string object key and a numeric `exp`. */
function isFileTokenClaims(value: unknown): value is FileToken {
  return isRecord(value) && typeof value.objectKey === 'string' && typeof value.exp === 'number'
}

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

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)

  // `atob` throws a DOMException on a tampered/malformed segment. Returning empty bytes instead makes
  // the HMAC comparison fail (→ verifyFileToken returns null → route 404s) rather than throwing a 500.
  // It runs during `crypto.subtle.verify`'s argument evaluation, before the promise exists, so a
  // `.catch` on that call would not cover it.
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    return new Uint8Array(new ArrayBuffer(0))
  }

  // Back with an explicit ArrayBuffer so the result is `Uint8Array<ArrayBuffer>` (a non-shared
  // BufferSource), which crypto.subtle.verify requires.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)

  return bytes
}

// Encode strings as UTF-8 bytes before base64url so non-ASCII token payload values survive the round trip.
const base64urlFromString = (value: string) => base64urlFromBytes(encoder.encode(value))
const base64urlToString = (value: string) => decoder.decode(base64urlToBytes(value))

function importKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

const HEADER = base64urlFromString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

/**
 * Signs a file token into a compact HS256 token.
 *
 * @param token - The object key and expiry to embed.
 * @param secret - The HMAC signing secret.
 * @returns The signed token (base64url header.body.signature).
 */
export async function signFileToken(token: FileToken, secret: string): Promise<string> {
  const signingInput = `${HEADER}.${base64urlFromString(JSON.stringify(token))}`
  const key = await importKey(secret, 'sign')
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))

  return `${signingInput}.${base64urlFromBytes(new Uint8Array(signature))}`
}

/**
 * Verifies a signed file token and returns its claims, or `null` if invalid, tampered, or expired.
 *
 * @param token - The token to verify.
 * @param secret - The HMAC signing secret.
 * @returns The claims when the signature and schema are valid and the token is unexpired, otherwise `null`.
 */
export async function verifyFileToken(token: string, secret: string): Promise<FileToken | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts as [string, string, string]

  // Pin the algorithm: we only ever issue this header, so a tampered/`none` header is rejected
  // outright (and verification below is always HMAC, never attacker-chosen).
  if (header !== HEADER) return null

  const key = await importKey(secret, 'verify')

  // crypto.subtle.verify is a constant-time comparison — do not hand-roll a string compare.
  const valid = await crypto.subtle
    .verify('HMAC', key, base64urlToBytes(signature), encoder.encode(`${header}.${body}`))
    .catch(() => false)
  if (!valid) return null

  try {
    const claims: unknown = JSON.parse(base64urlToString(body))

    // A signature can't be forged, but an authentically-signed link still expires: reject once `exp`
    // (seconds) has passed, so link lifetime is bounded independently of the storage object's.
    if (isFileTokenClaims(claims) && claims.exp * 1000 > Date.now()) {
      return { objectKey: claims.objectKey, exp: claims.exp }
    }
  } catch {
    /* fall through */
  }

  return null
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
    const token = (await signFileToken({ objectKey: stored.objectKey, exp }, options.secret)).replaceAll('.', '~')

    return new URL(`${basePath}/${token}/`, base).toString()
  }
}

// Compact HS256 tokens minted and verified with Web Crypto (no dependency), shared by every signed value the
// toolkit issues: download links, upload receipts and Worker upload grants. A token body is only base64url,
// readable by anyone holding it, so claims must never carry anything the holder shouldn't see.

import { isRecord } from '#type-guards.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Minimum accepted signing-secret length. HS256's security rests entirely on the secret's entropy, so
 * a short secret (an empty string, a `"secret"` placeholder) is brute-forceable and forges any token.
 * This is a floor against obviously-weak inputs, not a substitute for a high-entropy random secret.
 */
const MIN_SECRET_LENGTH = 32

/**
 * Fail fast on a signing secret too short to be safe for HS256. Everything that signs or verifies runs
 * this at construction, so a misconfiguration surfaces at startup rather than minting forgeable tokens
 * (or silently accepting forged ones) at request time.
 */
export function assertValidSigningSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Signing secret must be at least ${MIN_SECRET_LENGTH} characters.`)
  }
}

/** The claims every token carries: its expiry, as a Unix timestamp in **seconds**. */
interface SignedClaims {
  exp: number
}

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)

  // `atob` throws a DOMException on a tampered/malformed segment. Returning empty bytes instead makes
  // the HMAC comparison fail (→ verifyClaims returns null → a route 404s) rather than throwing a 500.
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

// Encode strings as UTF-8 bytes before base64url so non-ASCII claim values survive the round trip.
const base64urlFromString = (value: string) => base64urlFromBytes(encoder.encode(value))
const base64urlToString = (value: string) => decoder.decode(base64urlToBytes(value))

function importKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

const HEADER = base64urlFromString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

/**
 * Signs claims into a compact HS256 token (base64url header.body.signature).
 *
 * @param claims - The claims to embed, including `exp`.
 * @param secret - The HMAC signing secret.
 * @returns The signed token.
 */
export async function signClaims(claims: SignedClaims & Record<string, unknown>, secret: string): Promise<string> {
  const signingInput = `${HEADER}.${base64urlFromString(JSON.stringify(claims))}`
  const key = await importKey(secret, 'sign')
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))

  return `${signingInput}.${base64urlFromBytes(new Uint8Array(signature))}`
}

/**
 * Verifies a token's signature and expiry and returns its claims, or `null` if it is malformed,
 * tampered with, expired, or not a record carrying a numeric `exp`. The caller narrows the claims
 * further (purpose and shape) for its own token kind.
 *
 * @param token - The token to verify.
 * @param secret - The HMAC signing secret.
 * @returns The verified, unexpired claims, otherwise `null`.
 */
export async function verifyClaims(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts as [string, string, string]

  // Pin the algorithm: only this header is ever issued, so a tampered/`none` header is rejected
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

    // A signature can't be forged, but an authentically-signed token still expires: reject once `exp`
    // (seconds) has passed, so a token's lifetime is bounded independently of what it grants.
    if (isRecord(claims) && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now()) return claims
  } catch {
    /* fall through */
  }

  return null
}

/**
 * Encodes a token for a URL path segment. Its `.` separators become `~`, because a dot in the final
 * path segment 404s under `trailingSlash: 'always'` (Astro #16140); {@link tokenFromPathSegment}
 * reverses it.
 */
export function tokenToPathSegment(token: string): string {
  return token.replaceAll('.', '~')
}

/** Reverses {@link tokenToPathSegment}. */
export function tokenFromPathSegment(segment: string): string {
  return segment.replaceAll('~', '.')
}

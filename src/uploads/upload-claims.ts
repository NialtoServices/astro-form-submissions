import { signClaims, verifyClaims } from '#tokens.js'
import type { PendingUpload } from '#uploads/upload-target.js'

/**
 * What a signed upload token is for. A `receipt` proves to the form route that the upload route admitted
 * a file; a `put` grants one upload through {@link createUploadPutRoute}. Each verifier accepts only its
 * own purpose, and download tokens accept neither.
 */
export type UploadTokenPurpose = 'receipt' | 'put'

/**
 * What a `put` grant carries: the admitted file, with its filename reduced to a digest. A grant travels
 * in the request URL, where logs record it, and a token body is readable by anyone, so the name itself
 * (often personal, such as "Jane Smith passport.pdf") must not be in it.
 */
export interface UploadGrant extends Omit<PendingUpload, 'filename'> {
  /** The SHA-256 of the admitted filename, hex-encoded; the upload's filename header must match it. */
  filenameDigest: string
}

/**
 * The digest a `put` grant binds the filename by.
 *
 * @param filename - The admitted filename.
 * @returns Its SHA-256, hex-encoded.
 */
export async function filenameDigest(filename: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(filename))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Signs an admitted upload into a token for one purpose. A receipt carries the filename; a `put` grant
 * carries only its digest (see {@link UploadGrant}).
 *
 * @param use - The token's purpose.
 * @param upload - The admitted file the token describes.
 * @param ttlSeconds - How long the token stays valid.
 * @param secret - The HMAC signing secret.
 * @returns The signed token.
 */
export async function signUploadClaims(
  use: UploadTokenPurpose,
  upload: PendingUpload,
  ttlSeconds: number,
  secret: string
): Promise<string> {
  const { objectKey, filename, size, contentType } = upload
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const naming = use === 'put' ? { filenameDigest: await filenameDigest(filename) } : { filename }

  return signClaims({ use, objectKey, ...naming, size, contentType, exp }, secret)
}

/**
 * Verifies a token signed by {@link signUploadClaims} for the given purpose.
 *
 * @param use - The purpose the caller accepts.
 * @param token - The token to verify.
 * @param secret - The HMAC signing secret.
 * @returns The admitted upload (a receipt) or grant (a `put`), or `null` for a token that is invalid,
 *   expired, malformed or for another purpose.
 */
export async function verifyUploadClaims(use: 'receipt', token: string, secret: string): Promise<PendingUpload | null>
export async function verifyUploadClaims(use: 'put', token: string, secret: string): Promise<UploadGrant | null>
export async function verifyUploadClaims(
  use: UploadTokenPurpose,
  token: string,
  secret: string
): Promise<PendingUpload | UploadGrant | null> {
  const claims = await verifyClaims(token, secret)
  if (!claims || claims.use !== use) return null

  const { objectKey, filename, filenameDigest, size, contentType } = claims
  if (typeof objectKey !== 'string' || typeof contentType !== 'string') return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null

  if (use === 'put') {
    return typeof filenameDigest === 'string' ? { objectKey, filenameDigest, size, contentType } : null
  }

  return typeof filename === 'string' ? { objectKey, filename, size, contentType } : null
}

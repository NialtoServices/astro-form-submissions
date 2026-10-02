import { signClaims, verifyClaims } from '#tokens.js'
import { type PendingUpload } from '#uploads/upload-target.js'

/**
 * What a signed upload token is for. A `receipt` proves to the form route that the upload route admitted
 * a file; a `put` grants one upload through {@link createUploadPutRoute}. Each verifier accepts only its
 * own purpose, and download tokens accept neither.
 */
export type UploadTokenPurpose = 'receipt' | 'put'

/**
 * Signs an admitted upload into a token for one purpose.
 *
 * @param use - The token's purpose.
 * @param upload - The admitted file the token describes.
 * @param ttlSeconds - How long the token stays valid.
 * @param secret - The HMAC signing secret.
 * @returns The signed token.
 */
export function signUploadClaims(
  use: UploadTokenPurpose,
  upload: PendingUpload,
  ttlSeconds: number,
  secret: string
): Promise<string> {
  const { objectKey, filename, size, contentType } = upload
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds

  return signClaims({ use, objectKey, filename, size, contentType, exp }, secret)
}

/**
 * Verifies a token signed by {@link signUploadClaims} for the given purpose.
 *
 * @param use - The purpose the caller accepts.
 * @param token - The token to verify.
 * @param secret - The HMAC signing secret.
 * @returns The admitted upload, or `null` for a token that is invalid, expired, malformed or for another purpose.
 */
export async function verifyUploadClaims(
  use: UploadTokenPurpose,
  token: string,
  secret: string
): Promise<PendingUpload | null> {
  const claims = await verifyClaims(token, secret)
  if (!claims || claims.use !== use) return null

  const { objectKey, filename, size, contentType } = claims
  if (typeof objectKey !== 'string' || typeof filename !== 'string' || typeof contentType !== 'string') return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null

  return { objectKey, filename, size, contentType }
}

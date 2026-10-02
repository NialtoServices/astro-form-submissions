// AWS Signature Version 4 query-string presigning, on Web Crypto (no dependency), for the S3-compatible
// API R2 exposes. Only presigning is implemented: the toolkit never calls the S3 API itself, it hands a
// browser a URL to PUT to. Reference: "Authenticating Requests: Using Query Parameters (AWS Signature
// Version 4)" in the Amazon S3 API documentation.

const encoder = new TextEncoder()

/** Options for {@link presignURL}. */
export interface PresignURLOptions {
  /** The HTTP method the URL authorises (e.g. `PUT`). */
  method: string

  /** The object's URL. Its own query parameters, if any, are signed too. */
  url: URL

  /**
   * Headers the request must carry with exactly these values, beyond `host` (which is always signed).
   * Names are matched case-insensitively.
   */
  headers?: Record<string, string>

  /** The access key id of the credential. */
  accessKeyId: string

  /** The secret access key of the credential. */
  secretAccessKey: string

  /** The signing region; R2 uses `auto`. */
  region: string

  /** The signing service; `s3` for the S3-compatible API. */
  service: string

  /** How long the URL stays valid, in seconds (1 to 604800). */
  expiresInSeconds: number

  /** The signing instant. Default now. */
  date?: Date
}

/**
 * Percent-encodes per RFC 3986, as SigV4 requires: `encodeURIComponent` leaves `!'()*` unescaped, which
 * the canonical form does not.
 */
function encodeRFC3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value))
}

/**
 * Presigns a request as a URL carrying its own authentication. The payload is unsigned
 * (`UNSIGNED-PAYLOAD`), so the URL authorises any body; constrain what may be stored through the signed
 * headers and by checking the stored object afterwards.
 *
 * @param options - The request to authorise and the credential to sign it with.
 * @returns The presigned URL.
 */
export async function presignURL(options: PresignURLOptions): Promise<URL> {
  const { method, accessKeyId, secretAccessKey, region, service, expiresInSeconds } = options
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604_800) {
    throw new Error('A presigned URL must expire within 1 to 604800 seconds.')
  }

  const amzDate = (options.date ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`

  const headers = new Map<string, string>([['host', options.url.host]])
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '))
  }

  const headerNames = [...headers.keys()].sort()
  const signedHeaders = headerNames.join(';')
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers.get(name)}\n`).join('')

  const url = new URL(options.url)
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set('X-Amz-Credential', `${accessKeyId}/${credentialScope}`)
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(expiresInSeconds))
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders)

  const canonicalQuery = [...url.searchParams]
    .map(([key, value]) => [encodeRFC3986(key), encodeRFC3986(value)] as const)
    .sort(([keyA, valueA], [keyB, valueB]) => (keyA === keyB ? (valueA < valueB ? -1 : 1) : keyA < keyB ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')

  // S3 signs the path exactly as sent: each segment encoded once, slashes kept.
  const canonicalURI = url.pathname
    .split('/')
    .map((segment) => encodeRFC3986(decodeURIComponent(segment)))
    .join('/')

  const canonicalRequest = [
    method,
    canonicalURI,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join('\n')

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n')

  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp)
  const regionKey = await hmac(dateKey, region)
  const serviceKey = await hmac(regionKey, service)
  const signingKey = await hmac(serviceKey, 'aws4_request')
  const signature = hex(await hmac(signingKey, stringToSign))

  // The URL's own serialisation of the query is not the canonical form, but the server re-derives the
  // canonical form from the parameters, so only the signature itself must be appended verbatim.
  url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`
  return url
}

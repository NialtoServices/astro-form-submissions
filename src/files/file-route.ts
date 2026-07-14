import { attachmentDisposition } from '#content-disposition.js'
import { assertValidSigningSecret, verifyFileToken } from '#files/signing.js'
import { type FileStorage } from '#storage/storage.js'
import { type APIRoute } from 'astro'

// Used only when a custom store returns no stored metadata; the bundled storage adapter always echoes the real values.
const FALLBACK_CONTENT_TYPE = 'application/octet-stream'
const FALLBACK_FILENAME = 'download'

/** Configuration for {@link createFileRoute}. */
export interface CreateFileRouteConfig {
  /** The same storage the uploads were written to (e.g. an {@link R2Storage} with the same prefix). */
  storage: FileStorage

  /**
   * The HMAC secret the links were signed with (see {@link signedLink}). Must be at least 32
   * characters — rejected at construction otherwise.
   */
  secret: string

  /** Route param carrying the token (from the `[param].ts` filename). Default `token`. */
  tokenParam?: string
}

/**
 * Builds the `GET` handler for a signed-download endpoint (e.g. `src/pages/files/[token].ts`):
 * verify the token → stream the stored object as an attachment.
 *
 * A tampered or unknown token is a 404 (never reveal whether a token was ever valid); a valid token
 * whose object is gone (e.g. expired by a storage lifecycle rule) is a 410. Files are always served
 * with an `attachment` disposition and `nosniff`, so an allowed-but-hostile file can't execute in
 * the browser.
 */
export function createFileRoute(config: CreateFileRouteConfig): APIRoute {
  assertValidSigningSecret(config.secret)

  const tokenParam = config.tokenParam ?? 'token'

  return async ({ params }) => {
    // The link swapped the JWT's `.` separators to `~` so the path segment stays dot-free under
    // `trailingSlash: 'always'` (Astro #16140); swap them back to reconstruct the token.
    const token = (params[tokenParam] ?? '').replaceAll('~', '.')
    const payload = await verifyFileToken(token, config.secret)
    if (!payload) return new Response('Not found', { status: 404 })

    const object = await config.storage.get(payload.objectKey)
    if (!object) return new Response('This link has expired.', { status: 410 })

    // The token is opaque (object key + expiry), so filename and content-type come from the metadata the
    // store persisted at upload, never re-derived from client input. The disposition is always rebuilt
    // here as `attachment`; an adapter-supplied disposition is never trusted, so a store can't serve `inline`.
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': object.contentType ?? FALLBACK_CONTENT_TYPE,
        'Content-Disposition': attachmentDisposition(object.filename ?? FALLBACK_FILENAME),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  }
}

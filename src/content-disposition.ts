/**
 * Build an RFC 6266 `attachment` `Content-Disposition` value that survives any filename.
 *
 * Header values are ByteStrings, so interpolating a non-Latin-1 name (an em dash, or CJK text) into
 * `new Response` — or some storage bindings' `contentDisposition` — throws. This emits the real name
 * percent-encoded as UTF-8 in the RFC 5987 `filename*` form, plus an ASCII-only `filename` fallback
 * for legacy clients. Control characters (incl. CR/LF) are stripped so the value can't inject headers.
 *
 * @param filename - The original, possibly non-ASCII filename. A real `File.name` is already a
 *   USVString, but a direct custom-storage call could pass a lone UTF-16 surrogate; it's normalised to
 *   U+FFFD so the `encodeURIComponent` below can't throw a `URIError`.
 * @returns A header value safe to place in `Content-Disposition`.
 */
export function attachmentDisposition(filename: string): string {
  const CONTROL_CEILING = 0x1f
  const DELETE = 0x7f
  const PRINTABLE_ASCII_FLOOR = 0x20
  const PRINTABLE_ASCII_CEILING = 0x7e

  const cleaned = [...filename.toWellFormed()]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > CONTROL_CEILING && code !== DELETE
    })
    .join('')

  // A quoted-string fallback that is always valid: quotes and backslashes can't be escaped portably
  // across clients, and non-ASCII bytes aren't allowed here at all, so replace them all with `_`.
  const asciiFallback =
    [...cleaned]
      .map((character) => {
        if (character === '"' || character === '\\') return '_'

        const code = character.charCodeAt(0)
        return code >= PRINTABLE_ASCII_FLOOR && code <= PRINTABLE_ASCII_CEILING ? character : '_'
      })
      .join('') || 'download'

  // RFC 5987 ext-value: percent-encode as UTF-8. `encodeURIComponent` leaves `!'()*~-_.` unescaped;
  // of those `'()*` are not RFC 5987 attr-chars, so encode them too.
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

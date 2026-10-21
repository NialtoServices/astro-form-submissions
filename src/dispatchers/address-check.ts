/**
 * What no address or display name may hold anywhere: a character some software reads as a line break (a control
 * character, or the line or paragraph separator, the same set as `CONTROL_CHARACTERS` in `email.ts`), whitespace
 * other than a plain space (U+0020), which parsers disagree about, or the start of an RFC 2047 encoded word
 * (`=?`), which some parsers decode into text that can hold a second address.
 */
const NEVER_ALLOWED = /[\p{Cc}\u2028\u2029]|[^\S ]|=\?/u

/** What may not appear in either half of an address: whitespace, and every character mail syntax gives a meaning. */
const ADDRESS_PART_REFUSED = /[\s"(),:;<>@[\\\]]/u

/** What may not appear in an unquoted display name: every character mail syntax gives a meaning. */
const PLAIN_NAME_REFUSED = /["(),:;<>@[\\\]]/u

/** A display name in double quotes, with no quote or backslash inside. */
const QUOTED_NAME = /^"[^"\\]*"$/u

/**
 * Whether text is a bare `local@domain`: exactly one `@`, both sides free of whitespace and mail syntax, a
 * non-empty local part, and a domain of two or more dot-separated parts, none of them empty.
 */
function isBareAddress(text: string): boolean {
  const parts = text.split('@')
  if (parts.length !== 2) return false

  const [local = '', domain = ''] = parts
  if (local === '' || ADDRESS_PART_REFUSED.test(local)) return false
  if (ADDRESS_PART_REFUSED.test(domain)) return false

  const domainParts = domain.split('.')
  return domainParts.length > 1 && domainParts.every((part) => part !== '')
}

/**
 * Whether a resolved address is one plain address, in one of exactly two shapes, once surrounding spaces are
 * trimmed:
 *
 * - `local@domain`: one `@`, with neither side empty or holding a space or any of `" ( ) , : ; < > @ [ \ ]`,
 *   and a domain of dot-separated parts with none empty (no leading, trailing or doubled dot). Non-ASCII is fine
 *   (`zoë@exämple.example`).
 * - `Name <local@domain>`: the address as above, nothing after the `>`, and any spaces (or none) before the
 *   `<`. The name is either plain text with none of those characters, or one double-quoted string with no quote
 *   or backslash inside (`"Lovelace, Ada" <ada@example.com>`). The name may be empty.
 *
 * Neither shape may hold a control character, U+2028, U+2029 or whitespace other than a plain space anywhere,
 * nor `=?`, which opens an RFC 2047 encoded word. Nor may it hold a compatibility character, one that NFKC
 * normalisation changes: IDNA and some mail libraries apply NFKC, which folds a fullwidth comma or at sign
 * (`ada@example.com，eve＠example.org`) into the ASCII separator it resembles. Everything else is refused: comments,
 * groups, routes, domain literals, quoted local parts, escapes, several addresses and trailing text, any of which
 * some mail parser reads as more recipients than another.
 *
 * @param address - The resolved `to` or `replyTo`.
 * @returns `true` when the address takes one of the two shapes; never throws.
 */
export function isPlainAddress(address: string): boolean {
  if (typeof address !== 'string' || NEVER_ALLOWED.test(address)) return false
  if (address.normalize('NFKC') !== address) return false

  // Every other whitespace character is refused above, so this trims plain spaces only.
  const text = address.trim()
  if (!text.endsWith('>')) return isBareAddress(text)

  // An address holds no `<`, so a named address's own `<` is always the last one.
  const opening = text.lastIndexOf('<')
  if (opening === -1 || !isBareAddress(text.slice(opening + 1, -1))) return false

  const name = text.slice(0, opening).trimEnd()
  return QUOTED_NAME.test(name) || !PLAIN_NAME_REFUSED.test(name)
}

import fc from 'fast-check'

/** Every control character: the C0 range, DEL, and the C1 range, which some software reads as line breaks. */
export const controlCharacter = fc
  .oneof(fc.integer({ min: 0x00, max: 0x1f }), fc.integer({ min: 0x7f, max: 0x9f }))
  .map((codePoint) => String.fromCodePoint(codePoint))

/** Text that may carry anything at all, a control character included at some point. */
export const textWithControlCharacter = fc
  .tuple(fc.string({ unit: 'binary' }), controlCharacter, fc.string({ unit: 'binary' }))
  .map(([before, control, after]) => before + control + after)

/** A display name without control characters, as a sender might type one: any punctuation, any script. */
export const displayName = fc.string({ unit: 'grapheme' }).filter((name) => !/\p{Cc}/u.test(name))

/** A display name quoted as RFC 5322 requires, with its quotes and backslashes escaped. */
export const quoted = (name: string) => `"${name.replace(/["\\]/g, '\\$&')}"`

/** A bare address, from a small set so separate mailboxes in one header are easy to tell apart. */
const bareAddress = fc.constantFrom('ada@example.com', 'eve@example.org', 'bob@example.net')

/** One mailbox in any of the forms RFC 5322 allows: bare, named, quoted, or with a comment. */
const mailbox = fc.oneof(
  bareAddress,
  fc
    .tuple(fc.constantFrom('Ada', 'Ada Lovelace', 'Lovelace Ada'), bareAddress)
    .map(([name, address]) => `${name} <${address}>`),
  fc.tuple(displayName, bareAddress).map(([name, address]) => `${quoted(name)} <${address}>`),
  fc
    .tuple(fc.constantFrom('x', 'a, b', 'see eve@example.org'), bareAddress)
    .map(([comment, address]) => `Ada (${comment}) <${address}>`)
)

/** What could sit between two mailboxes: the list separators, and what a lenient parser might take for one. */
const separator = fc.constantFrom(',', ', ', ';', ' ', '  ', '\t', '')

/** One or more mailboxes, joined, sometimes wrapped as a named group. */
const mailboxList = fc
  .tuple(fc.array(mailbox, { minLength: 1, maxLength: 3 }), separator, fc.boolean())
  .map(([mailboxes, joiner, grouped]) => {
    const list = mailboxes.join(joiner)
    return grouped ? `Team: ${list};` : list
  })

/** Pieces that, spliced in, turn a well-formed header into a nearly-well-formed one. */
const ADDRESS_NOISE = ['<', '>', '"', '\\', ',', ';', ':', '@', '(', ')', ' ']

/** A string shaped like an address header: usually a well-formed list, sometimes with noise spliced in. */
export const addressLike = fc.oneof(
  { arbitrary: mailboxList, weight: 3 },
  fc.tuple(mailboxList, fc.nat(), fc.constantFrom(...ADDRESS_NOISE)).map(([header, position, noise]) => {
    const index = position % (header.length + 1)
    return header.slice(0, index) + noise + header.slice(index)
  })
)

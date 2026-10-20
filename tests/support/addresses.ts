import fc from 'fast-check'

/**
 * Every character some software reads as a line break: the C0 range, DEL, the C1 range, and the line and paragraph
 * separators U+2028 and U+2029.
 */
export const controlCharacter = fc
  .oneof(fc.integer({ min: 0x00, max: 0x1f }), fc.integer({ min: 0x7f, max: 0x9f }), fc.constantFrom(0x2028, 0x2029))
  .map((codePoint) => String.fromCodePoint(codePoint))

/** Text that may carry anything at all, a control character included at some point. */
export const textWithControlCharacter = fc
  .tuple(fc.string({ unit: 'binary' }), controlCharacter, fc.string({ unit: 'binary' }))
  .map(([before, control, after]) => before + control + after)

/**
 * A display name that may go inside double quotes as a sender might type one: any punctuation and any script, but
 * no quote, backslash, encoded word (`=?`), control character, line separator or compatibility character (one NFKC
 * normalisation changes).
 */
export const displayName = fc
  .string({ unit: 'grapheme' })
  .filter((name) => !/[\p{Cc}\u2028\u2029"\\]|=\?/u.test(name) && name.normalize('NFKC') === name)

/** A bare address, from a small set so separate mailboxes in one header are easy to tell apart. */
const bareAddress = fc.constantFrom('ada@example.com', 'eve@example.org', 'bob@example.net')

/**
 * What a comment can hold: inside one, a quote, a comma, a semicolon and an `@` are all literal, a backslash
 * escapes the next character, and comments nest. A lone quote here is what a check that reads quoted strings
 * without reading comments would take as opening one, hiding whatever follows up to the next mailbox's quote.
 */
const commentText = fc.constantFrom(
  'x',
  'a, b',
  'see eve@example.org',
  '"',
  '"x',
  '"a, b',
  '"eve@example.org; x',
  'x, "y',
  'a (b) c',
  'a (b, "c) d',
  'a \\) b, "c'
)

/**
 * What a domain literal can hold: in RFC 5322 a quote or parenthesis there is ordinary text, so a check that takes
 * it as opening a quoted string or comment hides whatever follows up to the next one.
 */
const domainLiteralText = fc.constantFrom('192.0.2.1', '"', '1"', '"1', '1"2', '(', ')')

/**
 * The common RFC 5322 forms of one mailbox: bare, named, quoted, with a comment before or after, or with a domain
 * literal. Quoted names, comments and domain literals are weighted up, since a quote in one meeting a quote in the
 * next is where a check that misreads either hides a separator.
 */
const MAILBOX_FORMS = [
  { arbitrary: bareAddress, weight: 1 },
  {
    arbitrary: fc
      .tuple(fc.constantFrom('Ada', 'Ada Lovelace', 'Lovelace Ada'), bareAddress)
      .map(([name, address]) => `${name} <${address}>`),
    weight: 1
  },
  {
    arbitrary: fc.tuple(displayName, bareAddress).map(([name, address]) => `"${name}" <${address}>`),
    weight: 2
  },
  {
    arbitrary: fc.tuple(commentText, bareAddress).map(([comment, address]) => `Ada (${comment}) <${address}>`),
    weight: 2
  },
  {
    arbitrary: fc.tuple(bareAddress, commentText).map(([address, comment]) => `${address} (${comment})`),
    weight: 2
  },
  {
    arbitrary: fc
      .tuple(fc.constantFrom('ada', 'eve', 'bob'), domainLiteralText)
      .map(([localPart, literal]) => `${localPart}@[${literal}]`),
    weight: 2
  },
  {
    arbitrary: fc
      .tuple(fc.constantFrom('ada', 'eve', 'bob'), domainLiteralText)
      .map(([localPart, literal]) => `Ada <${localPart}@[${literal}]>`),
    weight: 2
  }
]

/** One mailbox in any of the forms. */
const mailbox = fc.oneof(...MAILBOX_FORMS)

/**
 * Two or three mailboxes of one form. Every mailbox has an `@`, so a misread quote that hides a second address
 * must open in the first mailbox and close in the last, which is likeliest when they share a form.
 */
const sameFormMailboxes = fc
  .constantFrom(...MAILBOX_FORMS)
  .chain(({ arbitrary }) => fc.array(arbitrary, { minLength: 2, maxLength: 3 }))

/** What could sit between two mailboxes: the list separators, and what a lenient parser might take for one. */
const separator = fc.constantFrom(',', ', ', ';', ' ', '  ', '\t', '')

/**
 * One or more mailboxes, joined, now and then wrapped as a named group. A group ends in `;`, which any check
 * refuses at once, so groups are kept to a quarter of lists and the rest reach the subtler cases.
 */
const mailboxList = fc
  .tuple(
    fc.oneof(fc.array(mailbox, { minLength: 1, maxLength: 3 }), sameFormMailboxes),
    separator,
    fc.oneof({ arbitrary: fc.constant(false), weight: 3 }, fc.constant(true))
  )
  .map(([mailboxes, joiner, grouped]) => {
    const list = mailboxes.join(joiner)
    return grouped ? `Team: ${list};` : list
  })

/** Pieces that, spliced in, turn a well-formed header into a nearly-well-formed one. */
const ADDRESS_NOISE = ['<', '>', '"', '\\', ',', ';', ':', '@', '(', ')', '[', ']', ' ']

/** A string shaped like an address header: usually a well-formed list, sometimes with noise spliced in. */
export const addressLike = fc.oneof(
  { arbitrary: mailboxList, weight: 3 },
  fc.tuple(mailboxList, fc.nat(), fc.constantFrom(...ADDRESS_NOISE)).map(([header, position, noise]) => {
    const index = position % (header.length + 1)
    return header.slice(0, index) + noise + header.slice(index)
  })
)

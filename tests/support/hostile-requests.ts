import fc from 'fast-check'
import { contentTypeHeader } from './content-types.js'

/** Field names a sender controls: the form's own, the inspectors', and ones that probe object handling. */
const FIELD_NAMES = [
  'name',
  'email',
  'message',
  'lang',
  'website',
  'file',
  'cf-turnstile-response',
  '',
  '__proto__',
  'constructor',
  'toString',
  'name[]',
  'a.b'
]

/** A field value: honest, empty, blank, or arbitrary text of any length, including lone surrogates. */
const fieldValue = fc.oneof(
  fc.constantFrom('Ada', 'ada@example.com', 'Hello there', '', ' ', 'not-an-email'),
  fc.string({ unit: 'binary', maxLength: 300 })
)

/** The fields a form could carry, with a valid set mixed in often enough for some submissions to succeed. */
const fields = fc.oneof(
  fc.array(fc.tuple(fc.oneof(fc.constantFrom(...FIELD_NAMES), fc.string()), fieldValue), { maxLength: 8 }),
  {
    arbitrary: fc
      .array(fc.tuple(fc.constantFrom(...FIELD_NAMES), fieldValue), { maxLength: 4 })
      .map((extra) => [['name', 'Ada'], ['email', 'ada@example.com'], ['message', 'Hello there'], ...extra]),
    weight: 2
  }
)

/** A file part: honest PDF or PNG bytes, or arbitrary ones, under any name. */
const filePart = fc
  .tuple(
    fc.oneof(
      fc.constant(new TextEncoder().encode('%PDF-1.7\n1 0 obj')),
      fc.constant(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])),
      fc.uint8Array({ maxLength: 512 })
    ),
    fc.string({ unit: 'binary', maxLength: 40 })
  )
  .map(([bytes, name]) => new File([bytes], name))

/** A request body: urlencoded or multipart fields, raw bytes or text, or nothing at all. */
const body: fc.Arbitrary<BodyInit | undefined> = fc.oneof(
  fields.map((entries) => new URLSearchParams(entries)),
  fc.tuple(fields, fc.array(filePart, { maxLength: 3 })).map(([entries, files]) => {
    const formData = new FormData()
    for (const [name, value] of entries) formData.append(name, value)
    for (const file of files) formData.append('file', file)
    return formData
  }),
  fc.uint8Array({ maxLength: 4096 }),
  fc.string({ unit: 'binary', maxLength: 4096 }),
  fc.constant(undefined)
)

/** The `Accept` headers of the toolkit's script, a browser posting the form itself, and anything else. */
const accept = fc.oneof(
  fc.constantFrom(
    'application/json',
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '*/*',
    'text/html, application/json'
  ),
  fc.string()
)

/** A declared `Content-Length`: plausible or not, numeric or not. */
const contentLength = fc.oneof(fc.nat({ max: 20_000 }).map(String), fc.constantFrom('-1', '1e3', 'abc', ' 12 '))

/**
 * A header that is usually left for the body to set, or omitted, and sometimes overridden, so most requests
 * still parse and reach the later stages.
 */
const sometimes = <T>(arbitrary: fc.Arbitrary<T>) =>
  fc.oneof({ arbitrary: fc.constant(undefined), weight: 3 }, { arbitrary, weight: 1 })

/** The headers and body of a request that anyone could send to a form route. */
export const hostileRequest = fc.record({
  body,
  contentType: sometimes(contentTypeHeader),
  accept: fc.oneof(fc.constant(undefined), accept),
  contentLength: sometimes(contentLength)
})

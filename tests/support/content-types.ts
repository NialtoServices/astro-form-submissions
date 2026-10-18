import fc from 'fast-check'

/** Media types a form body could be labelled with, in the cases a client could send them. */
const MEDIA_TYPES = [
  'multipart/form-data',
  'MULTIPART/Form-Data',
  'application/x-www-form-urlencoded',
  'Application/X-WWW-Form-Urlencoded',
  'text/plain',
  'application/json',
  'multipart/mixed',
  'form-data',
  ''
]

/** Parameters, including quoted values that hide the separators a naive parser would split on. */
const PARAMETERS = [
  ';boundary=xyz',
  '; boundary="a,b"',
  '; charset=utf-8',
  '; x="multipart/form-data, application/x-www-form-urlencoded"',
  '; x="\\","',
  ';',
  '; ='
]

/** Optional whitespace, which a parser may or may not trim around a type or a separator. */
const whitespace = fc.constantFrom('', ' ', '\t', '  ')

/** One media type with its parameters, as an entry in a header that may list several. */
const mediaTypeEntry = fc
  .tuple(whitespace, fc.constantFrom(...MEDIA_TYPES), fc.array(fc.constantFrom(...PARAMETERS), { maxLength: 3 }))
  .map(([leading, mediaType, parameters]) => leading + mediaType + parameters.join(''))

/** A header listing one or more media types, as a client or a proxy that joins repeated headers might send. */
const listedContentType = fc
  .tuple(fc.array(mediaTypeEntry, { minLength: 1, maxLength: 3 }), fc.constantFrom(',', ', ', ' , '))
  .map(([entries, separator]) => entries.join(separator))

/** Free-form noise built from the same pieces and arbitrary printable text. */
const noisyContentType = fc
  .array(
    fc.oneof(
      { arbitrary: fc.constantFrom(...MEDIA_TYPES, ...PARAMETERS, ',', '"', '/'), weight: 4 },
      { arbitrary: fc.string(), weight: 1 }
    ),
    { minLength: 1, maxLength: 6 }
  )
  .map((pieces) => pieces.join(''))

/** A `Content-Type` header value, well-formed or not, that a request could arrive with. */
export const contentTypeHeader = fc.oneof({ arbitrary: listedContentType, weight: 3 }, noisyContentType)

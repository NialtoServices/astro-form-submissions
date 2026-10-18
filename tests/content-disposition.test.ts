import { attachmentDisposition } from '#content-disposition.js'
import { describe, expect, it } from 'vitest'

describe('attachmentDisposition', () => {
  it('always marks the response as an attachment', () => {
    expect(attachmentDisposition('quote.pdf')).toMatch(/^attachment;/)
  })

  it('keeps a plain ASCII name in the quoted fallback and the RFC 5987 form', () => {
    expect(attachmentDisposition('quote.pdf')).toBe('attachment; filename="quote.pdf"; filename*=UTF-8\'\'quote.pdf')
  })

  it('percent-encodes a non-ASCII name and replaces it with `_` in the ASCII fallback', () => {
    const value = attachmentDisposition('dev送.pdf')
    expect(value).toContain('filename="dev_.pdf"')
    expect(value).toContain("filename*=UTF-8''dev%E9%80%81.pdf")
  })

  it('strips control characters (incl. CR/LF and the C1 range) so the value cannot inject headers', () => {
    const value = attachmentDisposition('a\r\nb\tc\u0085d\u009b.pdf')
    expect(value).toBe('attachment; filename="abcd.pdf"; filename*=UTF-8\'\'abcd.pdf')
  })

  it('neutralises quotes and backslashes in the ASCII fallback', () => {
    expect(attachmentDisposition('a"b\\c.pdf')).toContain('filename="a_b_c.pdf"')
  })

  it('keeps percent signs out of the ASCII fallback, where some browsers would decode them', () => {
    expect(attachmentDisposition('a%41b.pdf')).toBe('attachment; filename="a_41b.pdf"; filename*=UTF-8\'\'a%2541b.pdf')
  })

  it('names the file `download` in both forms when the name is empty or only control characters', () => {
    for (const name of ['', '\r\n\t']) {
      expect(attachmentDisposition(name)).toBe('attachment; filename="download"; filename*=UTF-8\'\'download')
    }
  })

  it('does not throw on a lone UTF-16 surrogate (a hostile direct custom-storage call)', () => {
    const loneHighSurrogate = '\uD800'
    expect(() => attachmentDisposition(`evil${loneHighSurrogate}.pdf`)).not.toThrow()

    const value = attachmentDisposition(`evil${loneHighSurrogate}.pdf`)

    // U+FFFD (the replacement char) percent-encodes to %EF%BF%BD.
    expect(value).toContain('%EF%BF%BD')
  })
})

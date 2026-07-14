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

  it('strips control characters (incl. CR/LF) so the value cannot inject headers', () => {
    const value = attachmentDisposition('a\r\nb\tc.pdf')
    expect(value).not.toMatch(/[\r\n\t]/)
    expect(value).toContain('filename="abc.pdf"')
  })

  it('neutralises quotes and backslashes in the ASCII fallback', () => {
    expect(attachmentDisposition('a"b\\c.pdf')).toContain('filename="a_b_c.pdf"')
  })

  it('falls back to `download` when every character is stripped as a control char', () => {
    expect(attachmentDisposition('\r\n\t')).toContain('filename="download"')
  })

  it('does not throw on a lone UTF-16 surrogate (a hostile direct custom-storage call)', () => {
    const loneHighSurrogate = '\uD800'
    expect(() => attachmentDisposition(`evil${loneHighSurrogate}.pdf`)).not.toThrow()

    const value = attachmentDisposition(`evil${loneHighSurrogate}.pdf`)
    // U+FFFD (the replacement char) percent-encodes to %EF%BF%BD.
    expect(value).toContain('%EF%BF%BD')
  })
})

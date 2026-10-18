import { hasAnyExtension, hasExtension, storedFilename } from '#files/filename.js'
import { describe, expect, it } from 'vitest'

describe('storedFilename', () => {
  it('strips invisible format characters that can disguise a name', () => {
    expect(storedFilename('invoice\u202Efdp.js')).toBe('invoicefdp.js')
    expect(storedFilename('re\u200Bport.pdf')).toBe('report.pdf')
  })

  it("appends the type's first extension when the name ends in none of them", () => {
    expect(storedFilename('invoice.js', ['gif'])).toBe('invoice.js.gif')
    expect(storedFilename('scan', ['pdf'])).toBe('scan.pdf')
    expect(storedFilename('.gif', ['gif'])).toBe('.gif.gif')
  })

  it('keeps a name that already ends in one of them, whatever its case', () => {
    expect(storedFilename('PHOTO.JPEG', ['jpg', 'jpeg'])).toBe('PHOTO.JPEG')
    expect(storedFilename('photo.jpg', ['jpg', 'jpeg'])).toBe('photo.jpg')
  })

  it('keeps the name as given when the type names no extensions', () => {
    expect(storedFilename('invoice.js')).toBe('invoice.js')
    expect(storedFilename('invoice.js', [])).toBe('invoice.js')
  })
})

describe('hasExtension and hasAnyExtension', () => {
  it('read only the last extension, and never a leading or trailing dot', () => {
    expect(hasExtension('archive.pdf.js', ['pdf'])).toBe(false)
    expect(hasAnyExtension('archive.pdf.js')).toBe(true)
    expect(hasAnyExtension('IMG_1234')).toBe(false)
    expect(hasAnyExtension('.profile')).toBe(false)
    expect(hasAnyExtension('photo.')).toBe(false)
  })
})

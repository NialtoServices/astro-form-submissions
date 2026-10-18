import { hasAnyExtension, hasExtension, storedFilename } from '#files/filename.js'
import { describe, expect, it } from 'vitest'

describe('storedFilename', () => {
  it('strips bidirectional text controls that can disguise a name', () => {
    expect(storedFilename('invoice\u202Efdp.js')).toBe('invoicefdp.js')
    expect(storedFilename('report\u2066.pdf')).toBe('report.pdf')
  })

  it('keeps joiners that emoji sequences and some scripts need', () => {
    expect(storedFilename('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}.png')).toBe(
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}.png'
    )
    expect(storedFilename('نامه\u200Cها.pdf')).toBe('نامه\u200Cها.pdf')
  })

  it('drops trailing dots and whitespace, as Windows does when saving', () => {
    expect(storedFilename('invoice.js.')).toBe('invoice.js')
    expect(storedFilename('invoice.js. .')).toBe('invoice.js')
    expect(storedFilename('...')).toBe('upload')
  })

  it("appends the type's first extension when the name ends in none of them", () => {
    expect(storedFilename('invoice.js', ['gif'])).toBe('invoice.js.gif')
    expect(storedFilename('invoice.js.', ['gif'])).toBe('invoice.js.gif')
    expect(storedFilename('.js', ['gif'])).toBe('.js.gif')
    expect(storedFilename('scan', ['pdf'])).toBe('scan.pdf')
  })

  it('keeps a name that already ends in one of them, whatever the case of either', () => {
    expect(storedFilename('PHOTO.JPEG', ['jpg', 'jpeg'])).toBe('PHOTO.JPEG')
    expect(storedFilename('photo.jpg', ['jpg', 'jpeg'])).toBe('photo.jpg')
    expect(storedFilename('logo.svg', ['SVG'])).toBe('logo.svg')
    expect(storedFilename('.gif', ['gif'])).toBe('.gif')
  })

  it('keeps the name as given when the type names no extensions', () => {
    expect(storedFilename('invoice.js')).toBe('invoice.js')
    expect(storedFilename('invoice.js', [])).toBe('invoice.js')
  })
})

describe('hasExtension and hasAnyExtension', () => {
  it('read only the last extension, counting a leading dot but not a trailing one', () => {
    expect(hasExtension('archive.pdf.js', ['pdf'])).toBe(false)
    expect(hasAnyExtension('archive.pdf.js')).toBe(true)
    expect(hasAnyExtension('IMG_1234')).toBe(false)
    expect(hasAnyExtension('.js')).toBe(true)
    expect(hasAnyExtension('photo.')).toBe(false)
  })
})

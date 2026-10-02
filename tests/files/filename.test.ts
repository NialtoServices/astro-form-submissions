import { storedFilename } from '#files/filename.js'
import { describe, expect, it } from 'vitest'

describe('storedFilename', () => {
  it('strips CR, LF and double quotes', () => {
    expect(storedFilename('a"b\r\n.pdf')).toBe('ab.pdf')
  })

  it.each(['', '"\r\n'])('falls back to `upload` when nothing is left of %j', (name) => {
    expect(storedFilename(name)).toBe('upload')
  })

  it('keeps any other character, non-ASCII included', () => {
    expect(storedFilename('Quote – March.pdf')).toBe('Quote – March.pdf')
  })
})

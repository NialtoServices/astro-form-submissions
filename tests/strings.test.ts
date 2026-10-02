import { formatFileSize } from '#strings.js'
import { describe, expect, it } from 'vitest'

describe('formatFileSize', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [322_560, '315 KB'],
    [2_621_440, '2.5 MB']
  ])('formats %d bytes as %s', (bytes, formatted) => {
    expect(formatFileSize(bytes)).toBe(formatted)
  })

  it.each([
    [1_048_575, '1 MB'],
    [1_073_741_823, '1 GB'],
    [1_073_699_880, '1 GB']
  ])('steps up a unit when %d bytes would round to 1024', (bytes, formatted) => {
    expect(formatFileSize(bytes)).toBe(formatted)
  })

  it('keeps a size that rounds to just under 1024 in its unit', () => {
    expect(formatFileSize(1_073_689_395)).toBe('1023.9 MB')
  })

  it.each([-1, Number.NaN, Infinity])('returns an empty string for %s', (bytes) => {
    expect(formatFileSize(bytes)).toBe('')
  })
})

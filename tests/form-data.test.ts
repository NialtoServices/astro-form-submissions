import { getField } from '#form-data.js'
import { describe, expect, it } from 'vitest'

describe('getField', () => {
  it('trims a string value', () => {
    const data = new FormData()
    data.set('name', '  Ada  ')
    expect(getField(data, 'name')).toBe('Ada')
  })

  it('returns undefined for blank/whitespace values', () => {
    const data = new FormData()
    data.set('name', '   ')
    expect(getField(data, 'name')).toBeUndefined()
  })

  it('returns undefined for a missing field', () => {
    expect(getField(new FormData(), 'nope')).toBeUndefined()
  })

  it('returns undefined for a File value', () => {
    const data = new FormData()
    data.set('file', new File(['x'], 'x.txt'))
    expect(getField(data, 'file')).toBeUndefined()
  })
})

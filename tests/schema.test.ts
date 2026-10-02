import { formDataToObject } from '#schema.js'
import { describe, expect, it } from 'vitest'

describe('formDataToObject', () => {
  it('takes the trimmed first value of each name and drops blanks', () => {
    const data = new FormData()
    data.append('name', '  Ada  ')
    data.append('name', 'Grace')
    data.append('company', '   ')
    data.append('company', 'Acme')

    expect({ ...formDataToObject(data) }).toEqual({ name: 'Ada' })
  })

  it('omits a name whose first value is a file', () => {
    const data = new FormData()
    data.append('attachment', new File(['x'], 'x.txt'))
    data.append('attachment', 'text')

    expect({ ...formDataToObject(data) }).toEqual({})
  })

  it('skips prototype-polluting names', () => {
    const data = new FormData()
    data.append('__proto__', 'polluted')
    data.append('constructor', 'polluted')
    data.append('name', 'Ada')

    const object = formDataToObject(data)
    expect(Object.getPrototypeOf(object)).toBeNull()
    expect(Object.keys(object)).toEqual(['name'])
  })

  it('stays linear in the number of distinct names', () => {
    const data = new FormData()
    for (let index = 0; index < 80_000; index++) data.append(`field${index}`, 'x')

    const start = performance.now()
    const object = formDataToObject(data)

    expect(Object.keys(object)).toHaveLength(80_000)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})

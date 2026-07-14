import { formError } from '#errors.js'
import { jsonError, jsonFormError, jsonOk, jsonValidationError } from '#responses.js'
import { describe, expect, it } from 'vitest'

describe('jsonOk', () => {
  it('returns a 200 with an ok body and no-store caching', async () => {
    const response = jsonOk()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true })
  })
})

describe('jsonError', () => {
  it('returns the given status, message, and no-store caching', async () => {
    const response = jsonError(502, 'Provider down.')
    expect(response.status).toBe(502)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'Provider down.' })
  })
})

describe('formError', () => {
  it('mints an error value carrying its key, status, and default copy', () => {
    expect(formError('rateLimited', 429, 'Too many attempts.')).toEqual({
      key: 'rateLimited',
      status: 429,
      message: 'Too many attempts.'
    })
  })
})

describe('jsonFormError', () => {
  const error = formError('fileTooLarge', 413, 'A file is too large.')

  it("renders the error's own copy and status when the site provides no overrides", async () => {
    const response = jsonFormError(error)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'A file is too large.' })
  })

  it("prefers the site's override copy for the error's key", async () => {
    const response = jsonFormError(error, { fileTooLarge: 'Please keep each file under 10 MB.' })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Please keep each file under 10 MB.' })
  })

  it("falls back to the error's own copy when the overrides cover other keys", async () => {
    const response = jsonFormError(error, { verification: 'Please prove you are human.' })
    expect(await response.json()).toEqual({ error: 'A file is too large.' })
  })

  it("falls back to the error's own copy for keys that collide with inherited object members", async () => {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const response = jsonFormError(formError(key, 400, 'Default copy.'), {})
      expect(await response.json()).toEqual({ error: 'Default copy.' })
    }
  })

  it('resolves copy through a function override, which may read the request data', async () => {
    const overrides = (key: string, _default: string, { data }: { data?: FormData }) =>
      data?.get('lang') === 'fr' && key === 'fileTooLarge' ? 'Un fichier est trop volumineux.' : undefined

    const french = new FormData()
    french.set('lang', 'fr')
    expect(await jsonFormError(error, overrides, { data: french }).json()).toEqual({
      error: 'Un fichier est trop volumineux.'
    })
  })

  it("falls back to the error's own copy when the resolver returns undefined", async () => {
    const response = jsonFormError(error, () => undefined, { data: new FormData() })
    expect(await response.json()).toEqual({ error: 'A file is too large.' })
  })
})

describe('jsonValidationError', () => {
  it('carries the summary and per-field messages at 400', async () => {
    const response = jsonValidationError({
      summary: 'Please correct the highlighted fields.',
      fieldErrors: { email: 'Enter a valid email.', message: 'Message is too long.' }
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      error: 'Please correct the highlighted fields.',
      fieldErrors: { email: 'Enter a valid email.', message: 'Message is too long.' }
    })
  })

  it('omits fieldErrors entirely when there are none, so it reads like any keyed error', async () => {
    const response = jsonValidationError({ summary: 'Something is off.', fieldErrors: {} })
    expect(await response.json()).toEqual({ error: 'Something is off.' })
  })
})

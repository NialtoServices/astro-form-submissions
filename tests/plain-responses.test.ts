import { wantsPlainResponse } from '#plain-responses.js'
import { describe, expect, it } from 'vitest'

const request = (accept?: string) =>
  new Request('https://example.com/api/contact', { method: 'POST', headers: accept ? { Accept: accept } : {} })

describe('wantsPlainResponse', () => {
  it("answers a browser's own form post in plain form", () => {
    expect(wantsPlainResponse(request('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'))).toBe(true)
    expect(wantsPlainResponse(request('TEXT/HTML'))).toBe(true)
  })

  it("keeps JSON for the toolkit's script, a plain fetch, and anything that asks for JSON", () => {
    expect(wantsPlainResponse(request('application/json'))).toBe(false)
    expect(wantsPlainResponse(request('*/*'))).toBe(false)
    expect(wantsPlainResponse(request())).toBe(false)
    expect(wantsPlainResponse(request('text/html, application/json'))).toBe(false)
  })
})

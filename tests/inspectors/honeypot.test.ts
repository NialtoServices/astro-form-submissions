import { HoneypotInspector } from '#inspectors/honeypot.js'
import type { InspectionContext } from '#inspectors/inspector.js'
import { describe, expect, it } from 'vitest'

function contextFor(fields: Record<string, string>): InspectionContext {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return {
    submission: {},
    data,
    requestURL: new URL('https://example.com/api/form'),
    siteURL: new URL('https://example.com/'),
    submittedAt: new Date('2026-01-02T03:04:05Z'),
    clientAddress: '1.2.3.4'
  }
}

describe('HoneypotInspector', () => {
  it('silently drops a submission whose honeypot is filled', async () => {
    const result = await new HoneypotInspector({ fieldName: 'website' }).inspect(
      contextFor({ website: 'https://spam.example' })
    )
    expect(result).toEqual({ action: 'drop' })
  })

  it('accepts when the honeypot is absent', async () => {
    expect(await new HoneypotInspector({ fieldName: 'website' }).inspect(contextFor({}))).toEqual({ action: 'accept' })
  })

  it('accepts when the honeypot is empty or whitespace-only', async () => {
    const inspector = new HoneypotInspector({ fieldName: 'website' })
    expect(await inspector.inspect(contextFor({ website: '' }))).toEqual({ action: 'accept' })
    expect(await inspector.inspect(contextFor({ website: '   ' }))).toEqual({ action: 'accept' })
  })

  it('only inspects its configured field', async () => {
    const inspector = new HoneypotInspector({ fieldName: 'fax_number' })
    expect(await inspector.inspect(contextFor({ fax_number: 'bot' }))).toEqual({ action: 'drop' })
    expect(await inspector.inspect(contextFor({ website: 'bot' }))).toEqual({ action: 'accept' })
  })
})

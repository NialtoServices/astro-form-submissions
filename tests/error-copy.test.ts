import { FileUploads } from '#enrichers/index.js'
import { type FormErrors } from '#errors.js'
import { RateLimitGuard } from '#guards/index.js'
import { TurnstileInspector } from '#inspectors/index.js'
import { DEFAULT_ERROR_COPY, ERRORS } from '#route.js'
import { describe, expect, it } from 'vitest'

describe('DEFAULT_ERROR_COPY', () => {
  it('carries non-empty copy for every toolkit error key', () => {
    for (const [key, message] of Object.entries(DEFAULT_ERROR_COPY)) {
      expect(typeof message, key).toBe('string')
      expect(message.length, key).toBeGreaterThan(0)
    }
  })

  it("mirrors each raiser's own default copy, so the catalogue cannot drift", () => {
    expect(DEFAULT_ERROR_COPY.invalidForm).toBe(ERRORS.invalidForm.message)
    expect(DEFAULT_ERROR_COPY.send).toBe(ERRORS.send.message)
    expect(DEFAULT_ERROR_COPY.unavailable).toBe(ERRORS.unavailable.message)
    expect(DEFAULT_ERROR_COPY.validationFailed).toBe(ERRORS.validationFailed.message)
    expect(DEFAULT_ERROR_COPY.verification).toBe(TurnstileInspector.errors.verification.message)
    expect(DEFAULT_ERROR_COPY.rateLimited).toBe(RateLimitGuard.errors.rateLimited.message)
    expect(DEFAULT_ERROR_COPY.tooManyFiles).toBe(FileUploads.errors.tooManyFiles.message)
    expect(DEFAULT_ERROR_COPY.fileTooLarge).toBe(FileUploads.errors.fileTooLarge.message)
    expect(DEFAULT_ERROR_COPY.fileType).toBe(FileUploads.errors.fileType.message)
  })
})

describe('FormErrors typing', () => {
  it("accepts known toolkit keys and a site's own custom keys", () => {
    const knownKey: FormErrors = { verification: 'Prove you are human.' }
    const customKey: FormErrors = { requestTooLarge: 'Too big.' }
    void knownKey
    void customKey
  })

  it('rejects a non-string value for a key', () => {
    // @ts-expect-error copy must be a string
    const bad: FormErrors = { verification: 123 }
    void bad
  })
})

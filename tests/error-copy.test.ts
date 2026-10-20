import { FileUploads, UploadedFiles } from '#enrichers/index.js'
import { formError, type FormErrors } from '#errors.js'
import { RateLimitGuard } from '#guards/index.js'
import { TurnstileInspector } from '#inspectors/index.js'
import { jsonFormError } from '#responses.js'
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
    expect(DEFAULT_ERROR_COPY.filesTooLarge).toBe(FileUploads.errors.filesTooLarge.message)
    expect(DEFAULT_ERROR_COPY.fileRequired).toBe(FileUploads.errors.fileRequired.message)
    expect(DEFAULT_ERROR_COPY.fileType).toBe(FileUploads.errors.fileType.message)
    expect(DEFAULT_ERROR_COPY.uploadMissing).toBe(UploadedFiles.errors.uploadMissing.message)
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

describe('placeholders in copy', () => {
  const error = formError('fileTooLarge', 400, 'Each file must be {maxFileSize} or smaller.', {
    placeholders: { maxFileSize: '10 MB' }
  })

  it('fills placeholders in default and overridden copy', async () => {
    expect(await jsonFormError(error).json()).toEqual({ error: 'Each file must be 10 MB or smaller.' })
    expect(await jsonFormError(error, { fileTooLarge: 'Keep each file under {maxFileSize}, please.' }).json()).toEqual({
      error: 'Keep each file under 10 MB, please.'
    })
  })

  it("fills a resolver's copy too", async () => {
    const resolver: FormErrors = (_key, _default, { data }) =>
      data?.get('lang') === 'fr' ? 'Chaque fichier doit faire {maxFileSize} ou moins.' : undefined
    const french = new FormData()
    french.set('lang', 'fr')

    expect(await jsonFormError(error, resolver, { data: french }).json()).toEqual({
      error: 'Chaque fichier doit faire 10 MB ou moins.'
    })
    expect(await jsonFormError(error, resolver, { data: new FormData() }).json()).toEqual({
      error: 'Each file must be 10 MB or smaller.'
    })
  })

  it('leaves a token it has no value for as written', async () => {
    const response = jsonFormError(error, { fileTooLarge: 'Up to {maxFileSize} or {maxTotalSize}; {constructor}.' })

    expect(await response.json()).toEqual({ error: 'Up to 10 MB or {maxTotalSize}; {constructor}.' })
  })

  it('inserts a value as written, whatever characters it holds', async () => {
    const dollars = formError('fileType', 400, 'Please attach {types}.', {
      placeholders: { types: "$& and $' and $1" }
    })

    expect(await jsonFormError(dollars).json()).toEqual({ error: "Please attach $& and $' and $1." })
  })

  it('names the field in fieldErrors when the error has one', async () => {
    const named = formError('fileRequired', 400, 'Please attach a file.', { field: 'cv' })

    expect(await jsonFormError(named).json()).toEqual({
      error: 'Please attach a file.',
      fieldErrors: { cv: 'Please attach a file.' }
    })
  })
})

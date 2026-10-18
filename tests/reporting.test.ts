import { DestinationUnreachableError } from '#dispatchers/destination-unreachable-error.js'
import { PostmarkDeliveryError } from '#dispatchers/postmark-delivery-error.js'
import { OperationalError } from '#operational-error.js'
import { containedReporter, defaultErrorReporter, REPORTER_TIMEOUT_MS, type FormErrorStage } from '#reporting.js'
import { SubmissionVerdictError } from '#submission-verdict-error.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The line the default reporter writes for one error. */
async function loggedLine(error: unknown): Promise<string> {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await defaultErrorReporter(error, { stage: 'delivery' })
  return String(consoleSpy.mock.lastCall?.[0])
}

describe('defaultErrorReporter', () => {
  it("tells Postmark refusals apart by Postmark's code", async () => {
    expect(await loggedLine(new PostmarkDeliveryError(422, 406, 'ada@example.com is inactive'))).toBe(
      '[astro-form-submissions] delivery error: PostmarkDeliveryError code=406 status=422'
    )
    expect(await loggedLine(new PostmarkDeliveryError(422, 400))).toBe(
      '[astro-form-submissions] delivery error: PostmarkDeliveryError code=400 status=422'
    )
  })

  it('names the destination and the cause of an unreachable delivery', async () => {
    const timeout = new DOMException('This operation was aborted', 'AbortError')

    expect(await loggedLine(new DestinationUnreachableError('Discord', { cause: timeout }))).toBe(
      '[astro-form-submissions] delivery error: DestinationUnreachableError destination=Discord cause=AbortError'
    )
  })

  it('names an operational failure by its code and keeps its cause class', async () => {
    const error = new OperationalError('rate-limit.limiter-unavailable', 'Rate limiter unavailable; failing open', {
      cause: new TypeError('binding missing')
    })

    expect(await loggedLine(error)).toBe(
      '[astro-form-submissions] delivery error: OperationalError code=rate-limit.limiter-unavailable cause=TypeError'
    )
  })

  it('drops a destination that is not a bounded identifier', async () => {
    const error = Object.assign(new Error('boom'), { destination: 'ada@example.com' })

    expect(await loggedLine(error)).toBe('[astro-form-submissions] delivery error: Error')
  })
})

/** The line the default reporter warns with for one verdict report. */
async function warnedLine(error: unknown, stage: FormErrorStage = 'inspection'): Promise<string> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await defaultErrorReporter(error, { stage })
  expect(errorSpy).not.toHaveBeenCalled()
  return String(warnSpy.mock.lastCall?.[0])
}

describe('defaultErrorReporter on a verdict', () => {
  it('warns with the stage, the action, the code and the details', async () => {
    const error = new SubmissionVerdictError('reject', 'turnstile.hostname-mismatch', {
      expected: ['example.com'],
      solved: 'localhost'
    })

    expect(await warnedLine(error)).toBe(
      '[astro-form-submissions] inspection rejected: turnstile.hostname-mismatch expected=[example.com] solved=localhost'
    )
  })

  it('names drops and quarantines by their own action', async () => {
    expect(await warnedLine(new SubmissionVerdictError('drop', 'honeypot.filled', { field: 'website' }))).toBe(
      '[astro-form-submissions] inspection dropped: honeypot.filled field=website'
    )
    expect(await warnedLine(new SubmissionVerdictError('quarantine', 'spam.score', { score: 0.93 }), 'guard')).toBe(
      '[astro-form-submissions] guard quarantined: spam.score score=0.93'
    )
  })

  it('prints numbers and booleans as they are', async () => {
    const error = new SubmissionVerdictError('reject', 'file-uploads.too-large', {
      size: 31457280,
      limit: 26214400,
      retried: false
    })

    expect(await warnedLine(error, 'enrichment')).toBe(
      '[astro-form-submissions] enrichment rejected: file-uploads.too-large size=31457280 limit=26214400 retried=false'
    )
  })

  it('calls a verdict with no code, or an unsafe one, unspecified', async () => {
    expect(await warnedLine(new SubmissionVerdictError('reject'))).toBe(
      '[astro-form-submissions] inspection rejected: unspecified'
    )
    expect(await warnedLine(new SubmissionVerdictError('reject', 'blocked ada@example.com'))).toBe(
      '[astro-form-submissions] inspection rejected: unspecified'
    )
  })

  it('leaves out any detail whose key or value could carry submission data', async () => {
    const line = await warnedLine(
      new SubmissionVerdictError('reject', 'spam.blocked', {
        email: 'ada@example.com',
        note: 'free text here',
        'bad key': 'x',
        recipients: ['ops', 'ada@example.com'],
        score: 5
      })
    )

    expect(line).toBe('[astro-form-submissions] inspection rejected: spam.blocked score=5')
  })

  it('prints no details when an untyped stage gives a string or an array instead of a record', async () => {
    const asString = new SubmissionVerdictError('reject', 'spam.blocked', 'ada.lovelace@example.com' as never)
    const asArray = new SubmissionVerdictError('reject', 'spam.blocked', ['Ada', 'Lovelace'] as never)

    expect(await warnedLine(asString)).toBe('[astro-form-submissions] inspection rejected: spam.blocked')
    expect(await warnedLine(asArray)).toBe('[astro-form-submissions] inspection rejected: spam.blocked')
  })

  it('keeps an empty array as an empty list', async () => {
    expect(await warnedLine(new SubmissionVerdictError('reject', 'turnstile.token-rejected', { errorCodes: [] }))).toBe(
      '[astro-form-submissions] inspection rejected: turnstile.token-rejected errorCodes=[]'
    )
  })
})

describe('SubmissionVerdictError', () => {
  it('names the action and code in its message, never the details', () => {
    const error = new SubmissionVerdictError('reject', 'spam.blocked', { email: 'ada@example.com' })

    expect(error.message).toBe('The submission was rejected (spam.blocked).')
    expect(error.name).toBe('SubmissionVerdictError')
    expect(new SubmissionVerdictError('drop').message).toBe('The submission was dropped (no code given).')
  })
})

describe('containedReporter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('abandons a report that never settles once the timeout passes', async () => {
    vi.useFakeTimers()
    let settled = false
    const report = containedReporter(() => new Promise<void>(() => {}))(new Error('outage'), 'delivery').then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(REPORTER_TIMEOUT_MS - 1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await report
    expect(settled).toBe(true)
  })

  it('leaves no timer behind once a report settles', async () => {
    vi.useFakeTimers()
    await containedReporter(async () => {})(new Error('outage'), 'delivery')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains a reporter that rejects after the timeout', async () => {
    vi.useFakeTimers()
    const report = containedReporter(
      () =>
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('late')), REPORTER_TIMEOUT_MS * 2))
    )(new Error('outage'), 'delivery')

    await vi.advanceTimersByTimeAsync(REPORTER_TIMEOUT_MS * 2)
    await expect(report).resolves.toBeUndefined()
  })
})

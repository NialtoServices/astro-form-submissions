import { DestinationUnreachableError } from '#dispatchers/destination-unreachable-error.js'
import { PostmarkDeliveryError } from '#dispatchers/postmark-delivery-error.js'
import { defaultErrorReporter } from '#reporting.js'
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

  it('drops a destination that is not a bounded identifier', async () => {
    const error = Object.assign(new Error('boom'), { destination: 'ada@example.com' })

    expect(await loggedLine(error)).toBe('[astro-form-submissions] delivery error: Error')
  })
})

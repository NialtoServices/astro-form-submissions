import { DestinationUnreachableError } from '#dispatchers/destination-unreachable-error.js'
import type { EmailMessage } from '#dispatchers/email.js'
import { PostmarkDeliveryError, PostmarkTransport } from '#dispatchers/postmark.js'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { stubFetch } from '../support/harness.js'

const POSTMARK_URL = 'https://api.postmarkapp.com/email'

const message: EmailMessage = {
  from: 'from@example.com',
  to: 'to@example.com',
  replyTo: 'reply@example.com',
  subject: 'S',
  text: 'T',
  html: '<p>H</p>'
}

interface CapturedRequest {
  token: string | null
  body: Record<string, unknown>
}

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** Accept the next Postmark send and capture what actually crossed the wire. */
function captureSend(): Promise<CapturedRequest> {
  return new Promise((resolve) => {
    server.use(
      http.post(POSTMARK_URL, async ({ request }) => {
        resolve({
          token: request.headers.get('X-Postmark-Server-Token'),
          body: (await request.json()) as Record<string, unknown>
        })
        return HttpResponse.json({ ErrorCode: 0, Message: 'OK' })
      })
    )
  })
}

describe('PostmarkTransport', () => {
  it('sends the message to the Postmark API with the token and full content', async () => {
    const captured = captureSend()
    await new PostmarkTransport({ token: 'tok' }).deliver(message)

    const { token, body } = await captured
    expect(token).toBe('tok')
    expect(body).toEqual({
      From: 'from@example.com',
      To: 'to@example.com',
      ReplyTo: 'reply@example.com',
      Subject: 'S',
      TextBody: 'T',
      HtmlBody: '<p>H</p>',
      MessageStream: 'outbound'
    })
  })

  it('sends via a custom message stream when configured', async () => {
    const captured = captureSend()
    await new PostmarkTransport({ token: 'tok', messageStream: 'forms' }).deliver(message)

    const { body } = await captured
    expect(body.MessageStream).toBe('forms')
  })

  it('rejects when Postmark refuses the message', async () => {
    server.use(
      http.post(POSTMARK_URL, () => HttpResponse.json({ ErrorCode: 300, Message: 'Invalid email' }, { status: 422 }))
    )
    await expect(new PostmarkTransport({ token: 'tok' }).deliver(message)).rejects.toThrow()
  })

  it('rejects when the send exceeds the configured timeout', async () => {
    server.use(
      http.post(POSTMARK_URL, async () => {
        await delay(500)
        return HttpResponse.json({ ErrorCode: 0, Message: 'OK' })
      })
    )
    const failure = await new PostmarkTransport({ token: 'tok', timeoutSeconds: 0.05 })
      .deliver(message)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DestinationUnreachableError)
    expect(failure).toMatchObject({ destination: 'Postmark', cause: { name: 'AbortError' } })
  })

  it.each([Number.NaN, 0, -1])('refuses a `timeoutSeconds` of %s', (timeoutSeconds) => {
    expect(() => new PostmarkTransport({ token: 'tok', timeoutSeconds })).toThrow('PostmarkTransport `timeoutSeconds`')
  })

  it("exposes Postmark's refusal code as `code`", async () => {
    server.use(
      http.post(POSTMARK_URL, () =>
        HttpResponse.json({ ErrorCode: 406, Message: 'Inactive recipient' }, { status: 422 })
      )
    )
    const failure = await new PostmarkTransport({ token: 'tok' }).deliver(message).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PostmarkDeliveryError)
    expect(failure).toMatchObject({ code: 406, status: 422 })
  })
})

describe('PostmarkTransport on the runtime fetch', () => {
  let interceptedFetch: typeof fetch

  beforeAll(() => {
    interceptedFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = interceptedFetch
  })

  it('gives up on a refusal whose body stalls, once the timeout passes', async () => {
    // As the runtime fetch does, aborting the signal errors a body still being read.
    stubFetch(
      (_requestURL, requestInit) =>
        new Response(
          new ReadableStream({
            start: (controller) =>
              requestInit?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('This operation was aborted', 'AbortError'))
              )
          }),
          { status: 422 }
        )
    )
    const failure = await new PostmarkTransport({ token: 'tok', timeoutSeconds: 0.05 })
      .deliver(message)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PostmarkDeliveryError)
    expect(failure).toMatchObject({ status: 422 })
  })

  // Cloudflare Workers provides only fetch, so that is the path a deployed site takes. The request is
  // checked there rather than through a Node HTTP client, which would never meet Workers' restrictions.
  it('sends through the runtime fetch with the token and a JSON body', async () => {
    const fetchMock = stubFetch(() => Response.json({ ErrorCode: 0, Message: 'OK' }))
    await new PostmarkTransport({ token: 'tok' }).deliver(message)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(String(url)).toBe(POSTMARK_URL)
    expect(init?.method).toBe('POST')
    expect(headers.get('X-Postmark-Server-Token')).toBe('tok')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toMatchObject({ From: 'from@example.com', MessageStream: 'outbound' })
  })

  // Workers rejects a request carrying a cache mode it does not support, before it is sent.
  it('sets no cache mode on the request', async () => {
    const fetchMock = stubFetch(() => Response.json({ ErrorCode: 0, Message: 'OK' }))
    await new PostmarkTransport({ token: 'tok' }).deliver(message)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(init).not.toHaveProperty('cache')
    expect(url).not.toBeInstanceOf(Request)
  })
})

describe('PostmarkDeliveryError', () => {
  it("carries the HTTP status and Postmark's error code and message", async () => {
    server.use(
      http.post(POSTMARK_URL, () =>
        HttpResponse.json({ ErrorCode: 406, Message: 'You tried to send to an inactive recipient.' }, { status: 422 })
      )
    )

    const delivery = new PostmarkTransport({ token: 'tok' }).deliver(message)

    await expect(delivery).rejects.toBeInstanceOf(PostmarkDeliveryError)
    await expect(delivery).rejects.toMatchObject({
      status: 422,
      errorCode: 406,
      message: 'Postmark refused the message (HTTP 422, error 406): You tried to send to an inactive recipient.'
    })
  })

  it('carries the status alone when the response is not Postmark JSON', async () => {
    server.use(http.post(POSTMARK_URL, () => new HttpResponse('<html>Bad gateway</html>', { status: 502 })))

    const delivery = new PostmarkTransport({ token: 'tok' }).deliver(message)

    await expect(delivery).rejects.toBeInstanceOf(PostmarkDeliveryError)
    await expect(delivery).rejects.toMatchObject({
      status: 502,
      errorCode: undefined,
      message: 'Postmark refused the message (HTTP 502)'
    })
  })
})

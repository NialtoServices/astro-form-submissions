import type { EmailMessage } from '#dispatchers/email.js'
import { PostmarkTransport } from '#dispatchers/postmark.js'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

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
    await expect(new PostmarkTransport({ token: 'tok', timeoutSeconds: 0.05 }).deliver(message)).rejects.toThrow()
  })
})

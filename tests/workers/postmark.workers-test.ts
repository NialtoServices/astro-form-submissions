import type { EmailAttachment } from '#dispatchers/email.js'
import { PostmarkTransport } from '#dispatchers/postmark.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('PostmarkTransport on the Workers runtime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('encodes a 6 MB attachment, which Postmark receives as the same bytes', async () => {
    const content = new Uint8Array(6 * 1024 * 1024)
    for (let index = 0; index < content.length; index += 1) content[index] = (index * 31 + 7) % 256
    const attachment: EmailAttachment = { filename: 'cv.pdf', contentType: 'application/pdf', content }
    let sentBody = ''
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      sentBody = init?.body as string
      return Response.json({ ErrorCode: 0, Message: 'OK' })
    })

    await new PostmarkTransport({ token: 'tok' }).deliver({
      from: 'site@example.com',
      to: 'office@example.com',
      subject: 'S',
      text: 'T',
      html: '<p>H</p>',
      attachments: [attachment]
    })

    const [sent] = (JSON.parse(sentBody) as { Attachments: { Name: string; Content: string }[] }).Attachments
    expect(sent!.Name).toBe('cv.pdf')
    const decoded = Uint8Array.from(atob(sent!.Content), (character) => character.charCodeAt(0))

    // Comparing element by element through `toEqual` takes seconds on 6 MB.
    expect(decoded.length).toBe(content.length)
    expect(decoded.findIndex((byte, index) => byte !== content[index])).toBe(-1)
  })
})

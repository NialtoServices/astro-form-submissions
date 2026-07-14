import { DiscordDispatcher } from '#dispatchers/discord.js'
import { EmailDispatcher } from '#dispatchers/email.js'
import { PostmarkTransport } from '#dispatchers/postmark.js'
import { submissionNotificationTemplates } from '#dispatchers/submission-notification.js'
import { FileUploads } from '#enrichers/file-uploads.js'
import { RateLimitGuard, type RateLimiter } from '#guards/rate-limit.js'
import { HoneypotInspector } from '#inspectors/honeypot.js'
import { TurnstileInspector } from '#inspectors/turnstile.js'
import { createFormRoute } from '#route.js'
import { type FileStorage } from '#storage/storage.js'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { makeRouteContext } from './support/harness.js'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const POSTMARK_URL = 'https://api.postmarkapp.com/email'
const DISCORD_URL = 'https://discord.example/webhook'

// The site's declarative validator, exercised end-to-end against real Zod v4 (Standard Schema).
const contactSchema = z.object({
  name: z.string(),
  email: z.email(),
  message: z.string()
})

// Wires hit during a scenario, captured by the msw handlers below.
const postmarkRequests: Record<string, unknown>[] = []
const discordRequests: { embeds: { title: string; fields: { name: string; value: string }[] }[] }[] = []
let siteverifyCalls = 0
let siteverifyResponse: Record<string, unknown> = { success: true, hostname: 'example.com' }

const server = setupServer(
  http.post(SITEVERIFY_URL, async ({ request }) => {
    siteverifyCalls += 1

    // Enforce the siteverify request contract: a regression that drops or renames the core
    // fields must fail the happy-path tests rather than silently passing verification.
    const body = await request.formData()
    if (!body.get('secret') || !body.get('response')) {
      return HttpResponse.json({ success: false, 'error-codes': ['missing-input-secret'] }, { status: 400 })
    }
    return HttpResponse.json(siteverifyResponse)
  }),
  http.post(POSTMARK_URL, async ({ request }) => {
    postmarkRequests.push((await request.json()) as Record<string, unknown>)
    return HttpResponse.json({ ErrorCode: 0, Message: 'OK' })
  }),
  http.post(DISCORD_URL, async ({ request }) => {
    discordRequests.push((await request.json()) as (typeof discordRequests)[number])
    return HttpResponse.json({})
  })
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  postmarkRequests.length = 0
  discordRequests.length = 0
  siteverifyCalls = 0
  siteverifyResponse = { success: true, hostname: 'example.com' }
})
afterEach(() => server.resetHandlers())

/** The full production wiring: Turnstile inspector, Postmark email, Discord ping. */
function fullRoute() {
  return createFormRoute({
    schema: contactSchema,
    inspectors: [
      new HoneypotInspector({ fieldName: 'website' }),
      new TurnstileInspector({ secretKey: 'turnstile-secret' }),

      // Stands in for a future spam screener: quarantines anything mentioning "casino".
      {
        inspect: async (inspectionContext) =>
          String(inspectionContext.submission.message).includes('casino')
            ? { action: 'quarantine', reason: 'casino' }
            : { action: 'accept' }
      }
    ],
    dispatchers: [
      // Customer/owner email is safe by default: omitting acceptsQuarantined withholds flagged spam.
      new EmailDispatcher({
        transport: new PostmarkTransport({ token: 'postmark-token' }),
        templates: {
          subject: (submission) => `Enquiry from ${submission.name}`,
          text: (submission) => `Message: ${submission.message}`,
          html: (submission) => `<p>${submission.message}</p>`
        },
        from: 'site@example.com',
        to: 'owner@example.com',
        replyTo: (submission) => submission.email as string
      }),
      // The ops channel opts in, so it still pings and can surface the quarantine reason.
      new DiscordDispatcher({
        webhookUrl: DISCORD_URL,
        acceptsQuarantined: true,
        title: (submission, context) =>
          context.quarantined
            ? `Blocked enquiry from ${submission.name} (${context.quarantineReasons.join(', ')})`
            : `New enquiry from ${submission.name}`,
        fields: ['email']
      })
    ]
  })
}

function submit(overrides: Record<string, string> = {}) {
  const data = new FormData()
  data.set('name', 'Ada')
  data.set('email', 'ada@example.com')
  data.set('message', 'Hello there')
  data.set('cf-turnstile-response', 'token')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)

  return fullRoute()(makeRouteContext({ body: data, url: 'https://example.com/api/contact' }))
}

describe('the composed form pipeline', () => {
  it('verifies, emails the rendered submission, and pings Discord on the happy path', async () => {
    const response = await submit()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(siteverifyCalls).toBe(1)

    expect(postmarkRequests).toHaveLength(1)
    expect(postmarkRequests[0]).toMatchObject({
      From: 'site@example.com',
      To: 'owner@example.com',
      ReplyTo: 'ada@example.com',
      Subject: 'Enquiry from Ada',
      TextBody: 'Message: Hello there',
      HtmlBody: '<p>Hello there</p>'
    })

    expect(discordRequests).toHaveLength(1)
    const embed = discordRequests[0]!.embeds[0]!
    expect(embed.title).toBe('New enquiry from Ada')
    expect(embed.fields).toEqual([{ name: 'Email', value: 'ada@example.com', inline: true }])
  })

  it('withholds the email but still pings Discord when an inspector quarantines spam', async () => {
    const response = await submit({ message: 'Visit my casino' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(postmarkRequests).toHaveLength(0)
    expect(discordRequests).toHaveLength(1)
    expect(discordRequests[0]!.embeds[0]!.title).toBe('Blocked enquiry from Ada (casino)')
  })

  it('rejects the submission and delivers nothing when verification fails', async () => {
    siteverifyResponse = { success: false }
    const response = await submit()

    expect(response.status).toBe(400)
    expect(postmarkRequests).toHaveLength(0)
    expect(discordRequests).toHaveLength(0)
  })

  it('silently drops a honeypot-tripped submission before anything runs', async () => {
    const response = await submit({ website: 'https://spam.example' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    // Dropped before the Turnstile round-trip and before either dispatcher's wire is touched.
    expect(siteverifyCalls).toBe(0)
    expect(postmarkRequests).toHaveLength(0)
    expect(discordRequests).toHaveLength(0)
  })
})

describe('the composed pipeline with guards and file uploads', () => {
  const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]

  /** A recording storage double so tests can assert uploads and rollbacks at the seam. */
  function stubStorage() {
    const put = vi.fn(async () => {})
    const deleted: string[] = []
    const storage: FileStorage = {
      put,
      get: vi.fn(async () => null),
      delete: vi.fn(async (key: string) => void deleted.push(key))
    }
    return { storage, put, deleted }
  }

  function stubLimiter(success: boolean): RateLimiter {
    return { limit: vi.fn(async () => ({ success })) }
  }

  // The submission is only the validated input; the uploaded-file links live on `context.resources`.
  type Enquiry = {
    name: string
    email: string
    message: string
  }

  function uploadRoute(storage: FileStorage, limiter: RateLimiter) {
    return createFormRoute({
      guards: [new RateLimitGuard({ limiter })],
      schema: contactSchema,
      inspectors: [new TurnstileInspector({ secretKey: 'turnstile-secret' })],
      enrichers: [
        new FileUploads<Enquiry>({
          storage,
          link: async (stored) => `https://example.com/files/${stored.objectKey}/`,
          attachTo: 'files'
        })
      ],
      dispatchers: [
        // E and the resource type infer from the templates, so the dispatcher isn't annotated.
        new EmailDispatcher({
          transport: new PostmarkTransport({ token: 'postmark-token' }),
          templates: submissionNotificationTemplates<Enquiry, 'files'>({
            fields: ['name', 'email'],
            attachments: 'files'
          }),
          from: 'site@example.com',
          to: 'owner@example.com'
        })
      ]
    })
  }

  function submitWithFile(storage: FileStorage, limiter: RateLimiter, options: { withFile?: boolean } = {}) {
    const data = new FormData()
    data.set('name', 'Ada')
    data.set('email', 'ada@example.com')
    data.set('message', 'Please quote')
    data.set('cf-turnstile-response', 'token')
    if (options.withFile ?? true) {
      const buffer = new Uint8Array(64)
      buffer.set(PDF_HEADER)
      data.append('file', new File([buffer], 'quote.pdf'))
    }
    return uploadRoute(storage, limiter)(makeRouteContext({ body: data, url: 'https://example.com/api/contact' }))
  }

  it('uploads the file then emails the submission with a download link', async () => {
    const { storage, put } = stubStorage()
    const response = await submitWithFile(storage, stubLimiter(true))

    expect(response.status).toBe(200)
    expect(put).toHaveBeenCalledOnce()
    expect(postmarkRequests).toHaveLength(1)
    expect(String(postmarkRequests[0]!.HtmlBody)).toMatch(/href="https:[^"]+"/)
    expect(String(postmarkRequests[0]!.HtmlBody)).toContain('quote.pdf</a>')
    expect(String(postmarkRequests[0]!.TextBody)).toMatch(/quote\.pdf \(64 B\): https:\/\/example\.com\/files\//)
  })

  it('rejects a rate-limited request before the body is parsed or any file stored', async () => {
    const { storage, put } = stubStorage()
    const response = await submitWithFile(storage, stubLimiter(false))

    expect(response.status).toBe(429)
    expect(siteverifyCalls).toBe(0)
    expect(put).not.toHaveBeenCalled()
    expect(postmarkRequests).toHaveLength(0)
  })

  it('never uploads a file when Turnstile verification fails (verify before upload)', async () => {
    siteverifyResponse = { success: false }
    const { storage, put } = stubStorage()
    const response = await submitWithFile(storage, stubLimiter(true))

    expect(response.status).toBe(400)
    expect(put).not.toHaveBeenCalled()
    expect(postmarkRequests).toHaveLength(0)
  })

  it('rolls back the uploaded file when the email delivery fails', async () => {
    server.use(http.post(POSTMARK_URL, () => HttpResponse.json({ ErrorCode: 500 }, { status: 500 })))
    const { storage, put, deleted } = stubStorage()
    const response = await submitWithFile(storage, stubLimiter(true))

    expect(response.status).toBe(502)
    expect(put).toHaveBeenCalledOnce()
    // The stored object is deleted so a retry doesn't orphan it.
    expect(deleted).toHaveLength(1)
  })
})

describe('a real Zod v4 schema through the route', () => {
  const splitNameSchema = z
    .object({
      first_name: z.string().max(120),
      last_name: z.string().max(120),
      email: z.email(),
      message: z.string().max(5000)
    })
    .transform((fields) => ({
      name: `${fields.first_name} ${fields.last_name}`,
      email: fields.email,
      message: fields.message
    }))

  function route(onSubmission: (submission: { name: string; email: string; message: string }) => void) {
    return createFormRoute({
      schema: splitNameSchema,
      dispatchers: [{ dispatch: async (submission) => onSubmission(submission) }]
    })
  }

  function contextFor(overrides: Record<string, string> = {}) {
    const data = new FormData()
    data.set('first_name', 'Ada')
    data.set('last_name', 'Lovelace')
    data.set('email', 'ada@example.com')
    data.set('message', 'Hello there')
    for (const [key, value] of Object.entries(overrides)) data.set(key, value)
    return makeRouteContext({ body: data, url: 'https://example.com/api/contact' })
  }

  it('validates and transforms the inferred submission, carrying no siteHost key', async () => {
    let seen: { name: string } | undefined
    const response = await route((submission) => void (seen = submission))(contextFor())

    expect(response.status).toBe(200)
    expect(seen).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'Hello there'
    })
    expect(seen).not.toHaveProperty('siteHost')
  })

  it('rejects an invalid email with a per-field message keyed by the form field name', async () => {
    const response = await route(() => {})(contextFor({ email: 'not-an-email' }))
    const body = (await response.json()) as { error: string; fieldErrors?: Record<string, string> }

    expect(response.status).toBe(400)
    expect(body.fieldErrors?.email).toBeTruthy()
  })

  it('rejects an over-length field via .max()', async () => {
    const response = await route(() => {})(contextFor({ message: 'x'.repeat(5001) }))
    const body = (await response.json()) as { error: string; fieldErrors?: Record<string, string> }

    expect(response.status).toBe(400)
    expect(body.fieldErrors?.message).toBeTruthy()
  })
})

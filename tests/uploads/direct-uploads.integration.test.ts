import { EmailDispatcher } from '#dispatchers/email.js'
import { PostmarkTransport } from '#dispatchers/postmark.js'
import { submissionNotificationTemplates } from '#dispatchers/submission-notification.js'
import { FileUploads } from '#enrichers/file-uploads.js'
import { UploadedFiles } from '#enrichers/uploaded-files.js'
import { createFileRoute } from '#files/file-route.js'
import { signedLink } from '#files/signing.js'
import { TurnstileInspector } from '#inspectors/turnstile.js'
import { createFormRoute } from '#route.js'
import { R2Storage } from '#storage/r2.js'
import { R2PresignedUploadTarget } from '#uploads/r2-presigned-upload-target.js'
import { createUploadPutRoute } from '#uploads/upload-put-route.js'
import { createUploadRoute } from '#uploads/upload-route.js'
import type { UploadTarget } from '#uploads/upload-target.js'
import { WorkerUploadTarget } from '#uploads/worker-upload-target.js'
import type { APIRoute } from 'astro'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeRouteContext } from '../support/harness.js'
import { MemoryBucket } from '../support/memory-bucket.js'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const POSTMARK_URL = 'https://api.postmarkapp.com/email'
const SECRET = 'a-sufficiently-long-signing-secret'
const UPLOAD_PUT_PATH = '/api/contact/uploads'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PDF = new TextEncoder().encode('%PDF-1.7\n% a quote for a garage clearance')

const schema = z.object({ name: z.string(), email: z.email() })
type Enquiry = z.output<typeof schema>

// Turnstile tokens are single-use, so siteverify here refuses a token it has already seen: a flow that
// reused the upload route's token for the final submission would fail these tests.
const spentTokens = new Set<string>()
const postmarkRequests: { TextBody: string; HtmlBody: string }[] = []
let postmarkStatus = 200

const server = setupServer(
  http.post(SITEVERIFY_URL, async ({ request }) => {
    const token = String((await request.formData()).get('response'))
    const fresh = !spentTokens.has(token)
    spentTokens.add(token)
    return HttpResponse.json({ success: fresh, hostname: 'example.com' })
  }),
  http.post(POSTMARK_URL, async ({ request }) => {
    if (postmarkStatus !== 200)
      return HttpResponse.json({ ErrorCode: 500, Message: 'down' }, { status: postmarkStatus })

    postmarkRequests.push((await request.json()) as (typeof postmarkRequests)[number])
    return HttpResponse.json({ ErrorCode: 0, Message: 'OK' })
  })
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  spentTokens.clear()
  postmarkRequests.length = 0
  postmarkStatus = 200
})
afterEach(() => server.resetHandlers())

/** A site wired as a real one would be: every route sharing one bucket, prefix and secret. */
function site(target: UploadTarget) {
  const bucket = new MemoryBucket()
  const storage = new R2Storage({ bucket, prefix: 'uploads/' })
  const turnstile = new TurnstileInspector({ secretKey: 'turnstile-secret' })
  const limits = { maxFiles: 5, maxFileBytes: 100 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 }

  const uploadRoute = createUploadRoute({ schema, inspectors: [turnstile], target, secret: SECRET, ...limits })
  const putRoute = createUploadPutRoute({ storage, secret: SECRET })
  const formRoute = createFormRoute({
    schema,
    inspectors: [turnstile],
    enrichers: [
      new FileUploads<Enquiry>({ storage, link: signedLink({ secret: SECRET }), attachTo: 'files' }),
      new UploadedFiles<Enquiry>({
        storage,
        secret: SECRET,
        link: signedLink({ secret: SECRET }),
        attachTo: 'files',
        ...limits
      })
    ],
    dispatchers: [
      new EmailDispatcher({
        transport: new PostmarkTransport({ token: 'postmark-token' }),
        templates: submissionNotificationTemplates<Enquiry, 'files'>({
          fields: ['name', 'email'],
          attachments: 'files'
        }),
        from: 'site@example.com',
        to: 'owner@example.com'
      })
    ],
    onError: () => {}
  })
  const fileRoute = createFileRoute({ storage, secret: SECRET })

  return { bucket, uploadRoute, putRoute, formRoute, fileRoute }
}

function fields(token: string) {
  const data = new FormData()
  data.set('name', 'Ada')
  data.set('email', 'ada@example.com')
  data.set('cf-turnstile-response', token)
  return data
}

async function requestUploads(route: APIRoute, files: File[], token = 'token-1') {
  const data = fields(token)
  data.set('uploads', JSON.stringify(files.map((file) => ({ name: file.name, size: file.size, type: file.type }))))
  const response = await route(makeRouteContext({ body: data, url: 'https://example.com/api/contact/uploads/' }))
  return {
    response,
    uploads: (
      (await response.clone().json()) as {
        uploads?: { url: string; headers: Record<string, string>; receipt: string }[]
      }
    ).uploads
  }
}

/** PUTs a file through the Worker upload route exactly as the browser would follow the instruction. */
function putThroughWorker(route: APIRoute, upload: { url: string; headers: Record<string, string> }, file: File) {
  const token = upload.url.slice(UPLOAD_PUT_PATH.length + 1, -1)
  const request = new Request(`https://example.com${upload.url}`, {
    method: 'PUT',
    body: file,
    headers: { ...upload.headers, 'Content-Length': String(file.size) }
  })
  return route({ params: { token }, request } as unknown as Parameters<APIRoute>[0])
}

function submitReceipts(route: APIRoute, receipts: string[], token = 'token-2') {
  const data = fields(token)
  for (const receipt of receipts) data.append('upload', receipt)
  return route(makeRouteContext({ body: data, url: 'https://example.com/api/contact/' }))
}

/** The download links in the owner's email, in order. */
const emailedLinks = () =>
  [...postmarkRequests[0]!.TextBody.matchAll(/https:\/\/example\.com\/files\/[^/\s]+\//g)].map(([link]) => link)

function download(route: APIRoute, link: string) {
  return route({ params: { token: new URL(link).pathname.split('/')[2] } } as unknown as Parameters<APIRoute>[0])
}

const photo = new File([PNG], 'Kitchen – before.png', { type: 'image/png' })
const quote = new File([PDF], 'quote.pdf', { type: 'application/pdf' })

describe('direct uploads through the Worker (local development)', () => {
  const target = () => new WorkerUploadTarget({ secret: SECRET, basePath: UPLOAD_PUT_PATH })

  it('takes two files from grant to emailed link to download', async () => {
    const { uploadRoute, putRoute, formRoute, fileRoute } = site(target())

    const { response, uploads } = await requestUploads(uploadRoute, [photo, quote])
    expect(response.status).toBe(200)

    for (const [index, upload] of uploads!.entries()) {
      expect((await putThroughWorker(putRoute, upload, [photo, quote][index]!)).status).toBe(200)
    }

    const submitted = await submitReceipts(
      formRoute,
      uploads!.map((upload) => upload.receipt)
    )
    expect(submitted.status).toBe(200)
    expect(postmarkRequests).toHaveLength(1)
    expect(postmarkRequests[0]!.HtmlBody).toContain('Kitchen – before.png</a>')

    const [photoLink, quoteLink] = emailedLinks()
    const photoDownload = await download(fileRoute, photoLink!)
    const quoteDownload = await download(fileRoute, quoteLink!)

    expect(photoDownload.status).toBe(200)
    expect(new Uint8Array(await photoDownload.arrayBuffer())).toEqual(PNG)
    expect(photoDownload.headers.get('Content-Type')).toBe('image/png')
    expect(photoDownload.headers.get('Content-Disposition')).toContain("UTF-8''Kitchen%20%E2%80%93%20before.png")
    expect(new Uint8Array(await quoteDownload.arrayBuffer())).toEqual(PDF)
  })

  it('needs a fresh Turnstile token for the final submission', async () => {
    const { uploadRoute, putRoute, formRoute, bucket } = site(target())
    const { uploads } = await requestUploads(uploadRoute, [quote], 'only-token')
    await putThroughWorker(putRoute, uploads![0]!, quote)

    const reused = await submitReceipts(formRoute, [uploads![0]!.receipt], 'only-token')

    expect(reused.status).toBe(400)
    expect(postmarkRequests).toHaveLength(0)

    // Turnstile refuses before the enricher runs, so the upload stays for a retry with a fresh token.
    expect(bucket.objects.size).toBe(1)
    expect((await submitReceipts(formRoute, [uploads![0]!.receipt], 'fresh-token')).status).toBe(200)
  })

  it('deletes the uploads when the owner email fails, so a retry must upload again', async () => {
    const { uploadRoute, putRoute, formRoute, bucket } = site(target())
    const { uploads } = await requestUploads(uploadRoute, [photo])
    await putThroughWorker(putRoute, uploads![0]!, photo)

    postmarkStatus = 500
    const failed = await submitReceipts(formRoute, [uploads![0]!.receipt])
    expect(failed.status).toBe(502)
    expect(bucket.objects.size).toBe(0)

    postmarkStatus = 200
    const retried = await submitReceipts(formRoute, [uploads![0]!.receipt], 'token-3')
    expect(retried.status).toBe(400)
    expect(await retried.json()).toEqual({ error: "One of your files didn't finish uploading. Please try again." })
  })

  it('refuses a submission whose upload never arrived', async () => {
    const { uploadRoute, formRoute } = site(target())
    const { uploads } = await requestUploads(uploadRoute, [photo])

    const response = await submitReceipts(formRoute, [uploads![0]!.receipt])

    expect(response.status).toBe(400)
    expect(postmarkRequests).toHaveLength(0)
  })

  it('never accepts a receipt as a download link', async () => {
    const { uploadRoute, putRoute, fileRoute } = site(target())
    const { uploads } = await requestUploads(uploadRoute, [quote])
    await putThroughWorker(putRoute, uploads![0]!, quote)

    const response = await fileRoute({
      params: { token: uploads![0]!.receipt.replaceAll('.', '~') }
    } as unknown as Parameters<APIRoute>[0])

    expect(response.status).toBe(404)
  })

  it('still accepts a multipart file on the same route, for visitors without JavaScript', async () => {
    const { formRoute } = site(target())
    const data = fields('token-9')
    data.append('file', quote)

    const response = await formRoute(makeRouteContext({ body: data, url: 'https://example.com/api/contact/' }))

    expect(response.status).toBe(200)
    expect(emailedLinks()).toHaveLength(1)
  })
})

describe('direct uploads presigned to R2 (production)', () => {
  it('links a file R2 stored from the presigned PUT, under its decoded filename', async () => {
    const target = new R2PresignedUploadTarget({
      accountId: '0123456789abcdef',
      bucket: 'files-example',
      accessKeyId: 'R2ACCESSKEY',
      secretAccessKey: 'r2-secret-access-key',
      prefix: 'uploads/'
    })
    const { uploadRoute, formRoute, fileRoute, bucket } = site(target)

    const { uploads } = await requestUploads(uploadRoute, [photo])
    const instruction = uploads![0]!
    const objectKey = new URL(instruction.url).pathname.replace('/files-example/', '')

    // Stands in for R2 accepting the browser's PUT: it stores the bytes with the signed headers' values.
    bucket.objects.set(objectKey, {
      bytes: PNG,
      httpMetadata: { contentType: instruction.headers['Content-Type'] },
      customMetadata: { 'filename-uri': instruction.headers['x-amz-meta-filename-uri']! }
    })

    expect((await submitReceipts(formRoute, [instruction.receipt])).status).toBe(200)

    const downloaded = await download(fileRoute, emailedLinks()[0]!)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(PNG)
    expect(downloaded.headers.get('Content-Disposition')).toContain("UTF-8''Kitchen%20%E2%80%93%20before.png")
  })
})

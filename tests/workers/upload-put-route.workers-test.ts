import { R2Storage } from '#storage/r2.js'
import { createUploadPutRoute } from '#uploads/upload-put-route.js'
import { WorkerUploadTarget } from '#uploads/worker-upload-target.js'
import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const SECRET = 'a-sufficiently-long-signing-secret'
const BASE_PATH = '/api/contact/uploads'
const bytes = new TextEncoder().encode('%PDF-1.7 a quote for the garden')

/** PUTs `body` under a grant, declaring the admitted length and filename, as the client script does. */
function put(route: APIRoute, url: string, body: Uint8Array<ArrayBuffer>, filename: string) {
  const token = url.slice(BASE_PATH.length + 1, -1)
  const request = new Request(`https://example.com${url}`, {
    method: 'PUT',
    body,
    headers: {
      'Content-Length': String(bytes.length),
      'Content-Type': 'application/pdf',
      'x-amz-meta-filename-uri': encodeURIComponent(filename)
    }
  })
  return route({ params: { token }, request } as unknown as Parameters<APIRoute>[0])
}

describe('the Worker upload route on the Workers runtime', () => {
  it('stores a body of the admitted length once, refusing a second write or a short body', async () => {
    const storage = new R2Storage({ bucket: env.UPLOADS, prefix: `${crypto.randomUUID()}/` })
    const route = createUploadPutRoute({ storage, secret: SECRET, onError: () => {} })
    const target = new WorkerUploadTarget({ secret: SECRET, basePath: BASE_PATH })
    const upload = {
      objectKey: crypto.randomUUID(),
      filename: 'quote.pdf',
      size: bytes.length,
      contentType: 'application/pdf'
    }
    const { url } = await target.prepare(upload)
    const short = await target.prepare({ ...upload, objectKey: crypto.randomUUID() })

    expect((await put(route, url, bytes, 'quote.pdf')).status).toBe(200)
    expect((await put(route, url, bytes, 'quote.pdf')).status).toBe(409)
    expect((await put(route, short.url, bytes.slice(0, -1), 'quote.pdf')).status).toBe(502)
    expect((await storage.peek(upload.objectKey, 8))?.size).toBe(bytes.length)
  })
})

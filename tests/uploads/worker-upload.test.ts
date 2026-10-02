import { createFileRoute } from '#files/file-route.js'
import { signedLink } from '#files/signing.js'
import { R2Storage } from '#storage/r2.js'
import type { FileStorage } from '#storage/storage.js'
import { createUploadPutRoute } from '#uploads/upload-put-route.js'
import { WorkerUploadTarget } from '#uploads/worker-upload-target.js'
import type { APIRoute } from 'astro'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryBucket } from '../support/memory-bucket.js'

const SECRET = 'a-sufficiently-long-signing-secret'
const BASE_PATH = '/api/contact/uploads'

const bytes = new TextEncoder().encode('%PDF-1.7 a small quote document')
const upload = {
  objectKey: '6f1d2a4e-0000-4000-8000-000000000002',
  filename: 'Quote – March.pdf',
  size: bytes.length,
  contentType: 'application/pdf'
}

/** The grant segment of an instruction URL, as Astro hands it to the route's `[token]` param. */
const tokenOf = (url: string) => url.slice(BASE_PATH.length + 1, -1)

const put = (route: APIRoute, token: string, init: { body?: BodyInit; headers?: HeadersInit } = {}) => {
  const request = new Request(`https://example.com${BASE_PATH}/${token}/`, {
    method: 'PUT',
    body: init.body ?? bytes,
    headers: init.headers ?? { 'Content-Length': String(bytes.length), 'Content-Type': 'application/pdf' }
  })
  return route({ params: { token }, request } as unknown as Parameters<APIRoute>[0])
}

function setup() {
  const bucket = new MemoryBucket()
  const storage = new R2Storage({ bucket, prefix: 'uploads/' })
  const target = new WorkerUploadTarget({ secret: SECRET, basePath: BASE_PATH })
  const route = createUploadPutRoute({ storage, secret: SECRET })
  return { bucket, storage, target, route }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkerUploadTarget', () => {
  it('grants a root-relative PUT under the base path with a dot-free token', async () => {
    const instruction = await new WorkerUploadTarget({ secret: SECRET, basePath: `${BASE_PATH}/` }).prepare(upload)

    expect(instruction.method).toBe('PUT')
    expect(instruction.url).toMatch(new RegExp(`^${BASE_PATH}/[^/.]+/$`))
    expect(instruction.headers).toEqual({ 'Content-Type': 'application/pdf' })
  })

  it('refuses a short secret or a base path that is not root-relative', () => {
    expect(() => new WorkerUploadTarget({ secret: 'short', basePath: BASE_PATH })).toThrow('at least 32')
    expect(() => new WorkerUploadTarget({ secret: SECRET, basePath: 'api/uploads' })).toThrow('root-relative')
  })
})

describe('createUploadPutRoute', () => {
  it('streams the body into storage under the granted key with the granted metadata', async () => {
    const { bucket, storage, target, route } = setup()
    const instruction = await target.prepare(upload)

    const response = await put(route, tokenOf(instruction.url))

    expect(response.status).toBe(200)
    const stored = bucket.objects.get(`uploads/${upload.objectKey}`)
    expect(stored?.bytes).toEqual(bytes)
    expect(stored?.httpMetadata.contentType).toBe('application/pdf')
    expect((await storage.get(upload.objectKey))?.filename).toBe('Quote – March.pdf')
  })

  it('answers 404 for a tampered, foreign or expired grant, and stores nothing', async () => {
    const { bucket, target, route } = setup()
    const token = tokenOf((await target.prepare(upload)).url)
    const foreign = tokenOf(
      (
        await new WorkerUploadTarget({ secret: 'another-sufficiently-long-secret!', basePath: BASE_PATH }).prepare(
          upload
        )
      ).url
    )

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 16 * 60 * 1000)
    const expired = await put(route, token)
    vi.useRealTimers()

    expect((await put(route, `${token}x`)).status).toBe(404)
    expect((await put(route, foreign)).status).toBe(404)
    expect(expired.status).toBe(404)
    expect(bucket.objects.size).toBe(0)
  })

  it('refuses a download link presented as an upload grant', async () => {
    const { bucket, route } = setup()
    const link = await signedLink({ secret: SECRET })(upload, { siteURL: new URL('https://example.com/') } as never)
    const downloadToken = new URL(link).pathname.split('/')[2]!

    expect((await put(route, downloadToken)).status).toBe(404)
    expect(bucket.objects.size).toBe(0)
  })

  it('checks the declared length against the granted size', async () => {
    const { bucket, target, route } = setup()
    const token = tokenOf((await target.prepare(upload)).url)

    const missing = await put(route, token, { headers: { 'Content-Type': 'application/pdf' } })
    const larger = await put(route, token, { headers: { 'Content-Length': String(bytes.length + 1) } })
    const smaller = await put(route, token, { headers: { 'Content-Length': String(bytes.length - 1) } })

    expect(missing.status).toBe(411)
    expect(larger.status).toBe(413)
    expect(smaller.status).toBe(400)
    expect(bucket.objects.size).toBe(0)
  })

  it('reports a failed write and answers 502', async () => {
    const failure = new Error('bucket unavailable')
    const storage: FileStorage = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
      putStream: async () => {
        throw failure
      }
    }
    const onError = vi.fn()
    const route = createUploadPutRoute({ storage, secret: SECRET, onError })
    const token = tokenOf((await new WorkerUploadTarget({ secret: SECRET, basePath: BASE_PATH }).prepare(upload)).url)

    const response = await put(route, token)

    expect(response.status).toBe(502)
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('refuses to construct over a storage that cannot stream', () => {
    const storage: FileStorage = { put: async () => {}, get: async () => null, delete: async () => {} }
    expect(() => createUploadPutRoute({ storage, secret: SECRET })).toThrow('putStream')
  })

  it('stores a file the download route then serves', async () => {
    const { storage, target, route } = setup()
    await put(route, tokenOf((await target.prepare(upload)).url))

    const link = await signedLink({ secret: SECRET })(upload, { siteURL: new URL('https://example.com/') } as never)
    const download = await createFileRoute({ storage, secret: SECRET })({
      params: { token: new URL(link).pathname.split('/')[2] }
    } as unknown as Parameters<APIRoute>[0])

    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
  })
})

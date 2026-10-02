import type { StandardSchemaV1 } from '@standard-schema/spec'
import { formError } from '#errors.js'
import { IMAGE_TYPES } from '#files/sniff.js'
import type { Guard } from '#guards/guard.js'
import type { Inspector } from '#inspectors/inspector.js'
import { createUploadRoute, type UploadRouteConfig } from '#uploads/upload-route.js'
import type { PendingUpload, UploadTarget } from '#uploads/upload-target.js'
import { WorkerUploadTarget } from '#uploads/worker-upload-target.js'
import { describe, expect, it, vi } from 'vitest'
import { makeRouteContext } from '../support/harness.js'

const SECRET = 'a-sufficiently-long-signing-secret'

/** A hand-rolled Standard Schema requiring a `name` field, the sanctioned seam for a site's validator. */
const schema: StandardSchemaV1<Record<string, unknown>, { name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const record = value as Record<string, unknown>
      if (typeof record.name !== 'string') return { issues: [{ message: 'Please enter your name.', path: ['name'] }] }
      return { value: { name: record.name } }
    }
  }
}

/** An {@link UploadTarget} stub recording every admitted file it is asked to prepare. */
function recordingTarget() {
  const prepared: PendingUpload[] = []
  const target: UploadTarget = {
    prepare: async (upload) => {
      prepared.push(upload)
      return {
        url: `https://uploads.example/${upload.objectKey}`,
        method: 'PUT',
        headers: { 'Content-Type': upload.contentType }
      }
    }
  }
  return { target, prepared }
}

function request(descriptors: unknown, fields: Record<string, string> = { name: 'Ada' }) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  if (descriptors !== undefined)
    body.set('uploads', typeof descriptors === 'string' ? descriptors : JSON.stringify(descriptors))
  return makeRouteContext({ body })
}

function routeWith(overrides: Partial<UploadRouteConfig<typeof schema>> = {}) {
  const { target, prepared } = recordingTarget()
  const route = createUploadRoute({ schema, target, secret: SECRET, onError: () => {}, ...overrides })
  return { route, prepared }
}

const photo = { name: 'garden.jpg', size: 2_000_000, type: 'image/jpeg' }
const video = { name: 'loft.mov', size: 30_000_000, type: 'video/quicktime' }

describe('createUploadRoute', () => {
  it('names a file whose name is only stripped characters `upload`, as the multipart path does', async () => {
    const { route, prepared } = routeWith()
    await route(request([{ ...photo, name: '"\r\n' }]))

    expect(prepared[0]?.filename).toBe('upload')
  })

  it('signs receipts for the configured lifetime', async () => {
    const { route } = routeWith({ receiptTTLSeconds: 120 })
    const response = await route(request([photo]))
    const { uploads } = (await response.json()) as { uploads: { receipt: string }[] }
    const body = uploads[0]?.receipt.split('.')[1] ?? ''
    const claims = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { exp: number }

    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(110)
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120)
  })

  it('hands guards the address from the site’s resolver', async () => {
    const seen: (string | undefined)[] = []
    const { route } = routeWith({
      clientAddress: () => '192.0.2.10',
      guards: [{ guard: async (context) => (seen.push(context.clientAddress), { action: 'accept' }) }]
    })
    await route(request([photo]))

    expect(seen).toEqual(['192.0.2.10'])
  })

  it('grants a file whose name carries a lone surrogate, under a well-formed name', async () => {
    const { route } = routeWith({ target: new WorkerUploadTarget({ secret: SECRET, basePath: '/api/uploads' }) })
    const response = await route(request([{ ...photo, name: 'scan\ud800.jpg' }]))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      uploads: [{ headers: { 'x-amz-meta-filename-uri': 'scan%EF%BF%BD.jpg' } }]
    })
  })

  it('localises the failure when the upload target throws', async () => {
    const route = createUploadRoute({
      schema,
      secret: SECRET,
      onError: () => {},
      target: {
        prepare: async () => {
          throw new Error('presign failed')
        }
      },
      errors: (key, defaultMessage, { data }) =>
        key === 'unavailable' && data?.get('lang') === 'fr' ? 'Formulaire indisponible.' : defaultMessage
    })

    const response = await route(request([photo], { name: 'Ada', lang: 'fr' }))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Formulaire indisponible.' })
  })

  it('grants an upload and a receipt per file, in order, under server-generated keys', async () => {
    const { route, prepared } = routeWith({ maxFileBytes: 50_000_000, maxTotalBytes: 100_000_000 })

    const response = await route(request([photo, video]))
    const body = (await response.json()) as { ok: boolean; uploads: { url: string; method: string; receipt: string }[] }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.uploads).toHaveLength(2)
    expect(prepared.map((upload) => upload.filename)).toEqual(['garden.jpg', 'loft.mov'])
    expect(prepared.map((upload) => upload.size)).toEqual([2_000_000, 30_000_000])
    expect(new Set(prepared.map((upload) => upload.objectKey)).size).toBe(2)
    expect(prepared[0]!.objectKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.uploads[0]!.url).toBe(`https://uploads.example/${prepared[0]!.objectKey}`)
    expect(body.uploads[0]!.method).toBe('PUT')
    expect(body.uploads[0]!.receipt.split('.')).toHaveLength(3)
  })

  it('stores an accepted declared type as declared, and anything else as opaque bytes', async () => {
    const { route, prepared } = routeWith({ accept: IMAGE_TYPES, maxFileBytes: 50_000_000, maxTotalBytes: 100_000_000 })

    await route(request([photo, video, { name: 'notes.txt', size: 10, type: '' }]))

    expect(prepared.map((upload) => upload.contentType)).toEqual([
      'image/jpeg',
      'application/octet-stream',
      'application/octet-stream'
    ])
  })

  it('strips header-breaking characters from the filename and names an empty one', async () => {
    const { route, prepared } = routeWith()

    await route(
      request([
        { ...photo, name: 'evil"\r\n.jpg' },
        { ...photo, name: '' }
      ])
    )

    expect(prepared.map((upload) => upload.filename)).toEqual(['evil.jpg', 'upload'])
  })

  it('answers with an empty list when no files are described', async () => {
    const { route, prepared } = routeWith()

    expect(await (await route(request(undefined))).json()).toEqual({ ok: true, uploads: [] })
    expect(await (await route(request([]))).json()).toEqual({ ok: true, uploads: [] })
    expect(prepared).toHaveLength(0)
  })

  it('returns schema errors before granting anything', async () => {
    const { route, prepared } = routeWith()

    const response = await route(request([photo], {}))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ fieldErrors: { name: 'Please enter your name.' } })
    expect(prepared).toHaveLength(0)
  })

  it('refuses through a rejecting guard or inspector', async () => {
    const rejected = formError('verification', 400, 'Verification failed.')
    const guard: Guard = { guard: async () => ({ action: 'reject', error: rejected }) }
    const inspector: Inspector = { inspect: async () => ({ action: 'reject', error: rejected }) }

    const guarded = routeWith({ guards: [guard] })
    const inspected = routeWith({ inspectors: [inspector] })

    expect((await guarded.route(request([photo]))).status).toBe(400)
    expect((await inspected.route(request([photo]))).status).toBe(400)
    expect([...guarded.prepared, ...inspected.prepared]).toHaveLength(0)
  })

  it('grants nothing, silently, to a dropped or quarantined request', async () => {
    const drop: Inspector = { inspect: async () => ({ action: 'drop' }) }
    const quarantine: Inspector = { inspect: async () => ({ action: 'quarantine', reason: 'spammy' }) }

    const dropped = routeWith({ inspectors: [drop] })
    const quarantined = routeWith({ inspectors: [quarantine] })

    expect(await (await dropped.route(request([photo]))).json()).toEqual({ ok: true, uploads: [] })
    expect(await (await quarantined.route(request([photo]))).json()).toEqual({ ok: true, uploads: [] })
    expect([...dropped.prepared, ...quarantined.prepared]).toHaveLength(0)
  })

  it.each([
    ['too many files', { maxFiles: 1 }, [photo, photo], 'Please attach fewer files.'],
    [
      'a file over the per-file limit',
      { maxFileBytes: 1_000_000 },
      [photo],
      'A file is too large. Please attach smaller files.'
    ],
    [
      'files over the total limit',
      { maxFileBytes: 50_000_000, maxTotalBytes: 3_000_000 },
      [photo, photo],
      'A file is too large. Please attach smaller files.'
    ]
  ] as const)('refuses %s with the keyed copy', async (_label, limits, descriptors, message) => {
    const { route, prepared } = routeWith(limits)

    const response = await route(request(descriptors))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: message })
    expect(prepared).toHaveLength(0)
  })

  it.each([
    ['not JSON', '{nope'],
    ['not an array', { name: 'a.jpg', size: 1, type: 'image/jpeg' }],
    ['a zero size', [{ ...photo, size: 0 }]],
    ['a fractional size', [{ ...photo, size: 1.5 }]],
    ['a missing name', [{ size: 1, type: 'image/jpeg' }]],
    ['a non-object entry', ['garden.jpg']]
  ])('refuses descriptors that are %s', async (_label, descriptors) => {
    const { route, prepared } = routeWith()

    const response = await route(request(descriptors))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid form data.' })
    expect(prepared).toHaveLength(0)
  })

  it('uses the site’s copy overrides', async () => {
    const { route } = routeWith({ maxFiles: 1, errors: { tooManyFiles: 'Please attach no more than 1 file.' } })

    expect(await (await route(request([photo, photo]))).json()).toEqual({ error: 'Please attach no more than 1 file.' })
  })

  it('reports a failing target and answers unavailable', async () => {
    const failure = new Error('cannot presign')
    const onError = vi.fn()
    const route = createUploadRoute({
      schema,
      secret: SECRET,
      onError,
      target: {
        prepare: async () => {
          throw failure
        }
      }
    })

    const response = await route(request([photo]))

    expect(response.status).toBe(500)
    expect(onError).toHaveBeenCalledWith(failure, { stage: 'unexpected' })
  })

  it('refuses to construct with a short receipt secret', () => {
    expect(() => routeWith({ secret: 'short' })).toThrow('at least 32')
  })
})

import { R2PresignedUploadTarget } from '#uploads/r2-presigned-upload-target.js'
import { AwsClient } from 'aws4fetch'
import { afterEach, describe, expect, it, vi } from 'vitest'

const options = {
  accountId: '0123456789abcdef',
  bucket: 'files-example',
  accessKeyId: 'R2ACCESSKEY',
  secretAccessKey: 'r2-secret-access-key'
}

const upload = {
  objectKey: '6f1d2a4e-0000-4000-8000-000000000001',
  filename: 'Garden – before.mov',
  size: 12_345_678,
  contentType: 'video/quicktime'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('R2PresignedUploadTarget', () => {
  it('presigns a PUT to the object under the bucket and prefix', async () => {
    const target = new R2PresignedUploadTarget({ ...options, prefix: 'uploads/' })
    const instruction = await target.prepare(upload)
    const url = new URL(instruction.url)

    expect(instruction.method).toBe('PUT')
    expect(url.origin).toBe('https://0123456789abcdef.r2.cloudflarestorage.com')
    expect(url.pathname).toBe(`/files-example/uploads/${upload.objectKey}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match;x-amz-meta-filename-uri'
    )
  })

  it('returns the headers the upload must carry, with the filename percent-encoded', async () => {
    const instruction = await new R2PresignedUploadTarget(options).prepare(upload)

    expect(instruction.headers).toEqual({
      'Content-Type': 'video/quicktime',
      'If-None-Match': '*',
      'x-amz-meta-filename-uri': 'Garden%20%E2%80%93%20before.mov'
    })
  })

  it('signs the admitted size without asking the browser to send it', async () => {
    const instruction = await new R2PresignedUploadTarget(options).prepare(upload)

    expect(new URL(instruction.url).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length')
    expect(Object.keys(instruction.headers).map((name) => name.toLowerCase())).not.toContain('content-length')
  })

  it('produces a signature an independent SigV4 implementation agrees with', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T09:15:00Z'))
    const instruction = await new R2PresignedUploadTarget(options).prepare(upload)
    const issued = new URL(instruction.url)

    const client = new AwsClient({ ...options, region: 'auto', service: 's3' })
    const unsigned = new URL(issued.origin + issued.pathname)
    unsigned.searchParams.set('X-Amz-Expires', '900')
    const headers = { ...instruction.headers, 'Content-Length': String(upload.size) }
    const reference = await client.sign(new Request(unsigned, { method: 'PUT', headers }), {
      aws: { signQuery: true, datetime: '20261002T091500Z', allHeaders: true }
    })
    const referenceURL = new URL(reference.url)

    expect(referenceURL.searchParams.get('X-Amz-SignedHeaders')).toBe(issued.searchParams.get('X-Amz-SignedHeaders'))
    expect(issued.searchParams.get('X-Amz-Signature')).toBe(referenceURL.searchParams.get('X-Amz-Signature'))
  })

  it('produces a different signature for a different admitted size', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T09:15:00Z'))
    const target = new R2PresignedUploadTarget(options)
    const admitted = new URL((await target.prepare(upload)).url)
    const larger = new URL((await target.prepare({ ...upload, size: upload.size + 1 })).url)

    expect(larger.searchParams.get('X-Amz-Signature')).not.toBe(admitted.searchParams.get('X-Amz-Signature'))
  })

  it('honours a custom lifetime and a jurisdiction endpoint', async () => {
    const target = new R2PresignedUploadTarget({
      ...options,
      expiresInSeconds: 120,
      endpoint: 'https://0123456789abcdef.eu.r2.cloudflarestorage.com'
    })
    const url = new URL((await target.prepare(upload)).url)

    expect(url.host).toBe('0123456789abcdef.eu.r2.cloudflarestorage.com')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120')
  })

  it.each(['accountId', 'bucket', 'accessKeyId', 'secretAccessKey'] as const)(
    'refuses to construct without %s',
    (key) => {
      expect(() => new R2PresignedUploadTarget({ ...options, [key]: '' })).toThrow(`\`${key}\``)
    }
  )
})

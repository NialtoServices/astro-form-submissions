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
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host;x-amz-meta-filename-uri')
  })

  it('returns the headers the upload must carry, with the filename percent-encoded', async () => {
    const instruction = await new R2PresignedUploadTarget(options).prepare(upload)

    expect(instruction.headers).toEqual({
      'Content-Type': 'video/quicktime',
      'x-amz-meta-filename-uri': 'Garden%20%E2%80%93%20before.mov'
    })
  })

  it('produces a signature an independent SigV4 implementation agrees with', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T09:15:00Z'))
    const instruction = await new R2PresignedUploadTarget(options).prepare(upload)
    const issued = new URL(instruction.url)

    const client = new AwsClient({ ...options, region: 'auto', service: 's3' })
    const unsigned = new URL(issued.origin + issued.pathname)
    unsigned.searchParams.set('X-Amz-Expires', '900')
    const reference = await client.sign(new Request(unsigned, { method: 'PUT', headers: instruction.headers }), {
      aws: { signQuery: true, datetime: '20261002T091500Z', allHeaders: true }
    })

    expect(issued.searchParams.get('X-Amz-Signature')).toBe(new URL(reference.url).searchParams.get('X-Amz-Signature'))
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

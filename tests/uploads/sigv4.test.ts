import { presignURL } from '#uploads/sigv4.js'
import { AwsClient } from 'aws4fetch'
import { describe, expect, it } from 'vitest'

// The worked example in the Amazon S3 API reference, "Authenticating Requests: Using Query Parameters
// (AWS Signature Version 4)": a presigned GET for examplebucket/test.txt.
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  date: new Date('2013-05-24T00:00:00Z'),
  signature: 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
}

describe('presignURL', () => {
  it("reproduces AWS's published query-string signing example", async () => {
    const url = await presignURL({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      accessKeyId: AWS_EXAMPLE.accessKeyId,
      secretAccessKey: AWS_EXAMPLE.secretAccessKey,
      region: 'us-east-1',
      service: 's3',
      expiresInSeconds: 86_400,
      date: AWS_EXAMPLE.date
    })

    expect(url.searchParams.get('X-Amz-Signature')).toBe(AWS_EXAMPLE.signature)
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
  })

  it('signs a PUT with extra headers exactly as aws4fetch does', async () => {
    const date = new Date('2026-10-02T12:34:56Z')
    const objectURL = 'https://0123456789abcdef.r2.cloudflarestorage.com/uploads-bucket/uploads/9f1c%20key.mov'
    const headers = { 'Content-Type': 'video/quicktime', 'x-amz-meta-filename-uri': 'Garden%20%E2%80%93%20before.mov' }

    const url = await presignURL({
      method: 'PUT',
      url: new URL(objectURL),
      headers,
      accessKeyId: 'R2ACCESSKEY',
      secretAccessKey: 'r2-secret-access-key',
      region: 'auto',
      service: 's3',
      expiresInSeconds: 900,
      date
    })

    const client = new AwsClient({
      accessKeyId: 'R2ACCESSKEY',
      secretAccessKey: 'r2-secret-access-key',
      region: 'auto',
      service: 's3'
    })
    const reference = new URL(`${objectURL}?X-Amz-Expires=900`)
    const signed = await client.sign(new Request(reference, { method: 'PUT', headers }), {
      aws: { signQuery: true, datetime: '20261002T123456Z', allHeaders: true }
    })
    const expected = new URL(signed.url)

    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(expected.searchParams.get('X-Amz-SignedHeaders'))
    expect(url.searchParams.get('X-Amz-Signature')).toBe(expected.searchParams.get('X-Amz-Signature'))
  })

  it('signs the URL’s own query parameters', async () => {
    const options = {
      method: 'PUT',
      accessKeyId: 'KEY',
      secretAccessKey: 'SECRET',
      region: 'auto',
      service: 's3',
      expiresInSeconds: 60,
      date: new Date('2026-01-01T00:00:00Z')
    }
    const plain = await presignURL({ ...options, url: new URL('https://host.example/bucket/key') })
    const withQuery = await presignURL({ ...options, url: new URL('https://host.example/bucket/key?x-id=PutObject') })

    expect(withQuery.searchParams.get('x-id')).toBe('PutObject')
    expect(withQuery.searchParams.get('X-Amz-Signature')).not.toBe(plain.searchParams.get('X-Amz-Signature'))
  })

  it.each([0, 604_801, 1.5])('refuses an expiry of %s seconds', async (expiresInSeconds) => {
    await expect(
      presignURL({
        method: 'PUT',
        url: new URL('https://host.example/bucket/key'),
        accessKeyId: 'KEY',
        secretAccessKey: 'SECRET',
        region: 'auto',
        service: 's3',
        expiresInSeconds
      })
    ).rejects.toThrow('1 to 604800 seconds')
  })
})

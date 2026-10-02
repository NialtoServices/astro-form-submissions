import { FileUploads } from '#enrichers/file-uploads.js'
import { UploadedFiles } from '#enrichers/uploaded-files.js'
import { R2Storage } from '#storage/r2.js'
import { R2PresignedUploadTarget } from '#uploads/r2-presigned-upload-target.js'
import { createUploadRoute } from '#uploads/upload-route.js'
import { WorkerUploadTarget } from '#uploads/worker-upload-target.js'
import { describe, expect, it } from 'vitest'
import { MemoryBucket } from './support/memory-bucket.js'

const SECRET = 'a-sufficiently-long-signing-secret!'
const storage = new R2Storage({ bucket: new MemoryBucket() })
const link = async () => 'https://example.com/files/x/'
const target = new WorkerUploadTarget({ secret: SECRET, basePath: '/api/uploads' })
const schema = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => ({ value: value as Record<string, unknown> })
  }
}

describe('numeric options at construction', () => {
  it.each(['maxFiles', 'maxFileBytes', 'maxTotalBytes'] as const)('FileUploads refuses a NaN `%s`', (option) => {
    expect(() => new FileUploads({ storage, link, [option]: Number.NaN })).toThrow(`FileUploads \`${option}\``)
  })

  it.each(['maxFiles', 'maxFileBytes', 'maxTotalBytes'] as const)('UploadedFiles refuses a NaN `%s`', (option) => {
    expect(() => new UploadedFiles({ storage, secret: SECRET, link, [option]: Number.NaN })).toThrow(
      `UploadedFiles \`${option}\``
    )
  })

  it.each(['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'receiptTTLSeconds'] as const)(
    'createUploadRoute refuses a NaN `%s`',
    (option) => {
      expect(() => createUploadRoute({ schema, target, secret: SECRET, [option]: Number.NaN })).toThrow(
        `createUploadRoute \`${option}\``
      )
    }
  )

  it.each([0, -1, Infinity, 1.5])('refuses a `maxFiles` of %s', (maxFiles) => {
    expect(() => createUploadRoute({ schema, target, secret: SECRET, maxFiles })).toThrow(
      'createUploadRoute `maxFiles` must be a finite positive integer.'
    )
  })

  it('accepts a fractional byte limit', () => {
    expect(() => new FileUploads({ storage, link, maxFileBytes: 1.5 * 1024 * 1024 })).not.toThrow()
  })

  it('WorkerUploadTarget refuses a NaN `ttlSeconds`', () => {
    expect(() => new WorkerUploadTarget({ secret: SECRET, basePath: '/api/uploads', ttlSeconds: Number.NaN })).toThrow(
      'WorkerUploadTarget `ttlSeconds`'
    )
  })

  it('R2PresignedUploadTarget refuses an `expiresInSeconds` past a week', () => {
    const credentials = { accountId: 'account', bucket: 'bucket', accessKeyId: 'key', secretAccessKey: 'secret' }

    expect(() => new R2PresignedUploadTarget({ ...credentials, expiresInSeconds: 604_801 })).toThrow(
      'R2PresignedUploadTarget `expiresInSeconds` must be at most 604800.'
    )
  })
})

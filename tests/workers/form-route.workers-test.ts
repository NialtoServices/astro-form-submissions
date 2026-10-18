import type { StandardSchemaV1 } from '@standard-schema/spec'
import { DEFAULT_MAX_TEXT_BODY_BYTES } from '#admission.js'
import { FileUploads } from '#enrichers/file-uploads.js'
import { signedLink } from '#files/signing.js'
import { createFormRoute } from '#route.js'
import { R2Storage } from '#storage/r2.js'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { makeRouteContext } from '../support/harness.js'

const SECRET = 'a-sufficiently-long-signing-secret'

const schema: StandardSchemaV1<Record<string, unknown>, { name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) =>
      typeof (value as { name?: unknown }).name === 'string'
        ? { value: { name: (value as { name: string }).name } }
        : { issues: [{ message: 'Name is required.', path: ['name'] }] }
  }
}

/** A route that stores files in the test bucket, as a Workers site's would. */
function routeWithUploads() {
  const storage = new R2Storage({ bucket: env.UPLOADS, prefix: `${crypto.randomUUID()}/` })
  return createFormRoute({
    schema,
    enrichers: [new FileUploads({ storage, link: signedLink({ secret: SECRET }) })],
    onError: () => {}
  })
}

describe('the form route on the Workers runtime', () => {
  it('holds an urlencoded body to the text limit, even beside FileUploads', async () => {
    const body = `name=${'a'.repeat(DEFAULT_MAX_TEXT_BODY_BYTES)}`

    const response = await routeWithUploads()(
      makeRouteContext({ body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    )

    expect(response.status).toBe(413)
  })

  it('holds a comma-joined content type to the text limit', async () => {
    const response = await routeWithUploads()(
      makeRouteContext({
        body: 'a&'.repeat(DEFAULT_MAX_TEXT_BODY_BYTES),
        headers: { 'Content-Type': 'multipart/form-data, application/x-www-form-urlencoded' }
      })
    )

    expect(response.status).toBe(413)
  })

  it('parses a crafted urlencoded body at the text limit quickly', async () => {
    const startedAt = Date.now()

    const response = await routeWithUploads()(
      makeRouteContext({
        body: 'a&'.repeat(DEFAULT_MAX_TEXT_BODY_BYTES / 2),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      })
    )

    expect(response.status).toBe(400)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('reads a multipart body with a file past the text limit, and stores the file', async () => {
    const contents = new Uint8Array(2 * 1024 * 1024)
    contents.set(new TextEncoder().encode('%PDF-1.7'))
    const data = new FormData()
    data.set('name', 'Ada')
    data.set('file', new File([contents], 'quote.pdf'))

    const response = await routeWithUploads()(makeRouteContext({ body: data }))

    expect(response.status).toBe(200)
  })
})

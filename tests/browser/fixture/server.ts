// The browser suite's own HTTP server: static pages that load the built client, and form routes built from the
// built package, so the suite exercises exactly what a site installs. Playwright starts it for the test run and
// stops it afterwards (see playwright.config.ts); it is never a developer's server.
//
// Node runs this file directly, stripping its types, so it uses erasable TypeScript only: no enums, namespaces
// or parameter properties.

import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname } from 'node:path'
import type { APIContext, APIRoute } from 'astro'
import { z } from 'zod'
import type * as Toolkit from '../../../src/index.ts'
import { FIXTURE_ORIGIN, FIXTURE_PORT, RUN_COOKIE_NAME, type RecordedEmail } from './shared.ts'

// MARK: - Configuration

const PACKAGE_ROOT_URL = new URL('../../../', import.meta.url)
const DIST_ENTRY_URL = new URL('dist/index.js', PACKAGE_ROOT_URL)
const CLIENT_DIR_URL = new URL('dist/client/', PACKAGE_ROOT_URL)
const FIXTURE_DIR_URL = new URL('./', import.meta.url)
const PAGES_DIR_URL = new URL('pages/', import.meta.url)

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
}

if (!existsSync(DIST_ENTRY_URL)) {
  console.error('[fixture-server] dist/ is missing: run `pnpm build` before `pnpm test:browser`.')
  process.exit(1)
}

// The types come from the source, which a type check can always see; the code is the build, which only exists
// after `pnpm build`.
const toolkit = (await import(DIST_ENTRY_URL.href)) as typeof Toolkit

// MARK: - Recorded Emails

/** The test run each request belongs to, read from its {@link RUN_COOKIE_NAME} cookie. */
const currentRun = new AsyncLocalStorage<string>()

const recordedEmailsByRun = new Map<string, RecordedEmail[]>()

/** Records every message under the run whose request sent it, in place of a real provider. */
const recordingTransport: Toolkit.EmailTransport = {
  async deliver(message) {
    const runId = currentRun.getStore() ?? ''
    const recordedEmail: RecordedEmail = {
      ...message,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.content).toString('base64')
      }))
    }
    recordedEmailsByRun.set(runId, [...(recordedEmailsByRun.get(runId) ?? []), recordedEmail])
  }
}

// MARK: - Form Routes

// The route trims each field and leaves a blank one out, so a blank field reaches the schema as missing.
const contactSchema = z.object({
  name: z.string('Please enter your name.').max(120),
  email: z.email('Please enter a valid email address.'),
  message: z.string('Please enter a message.').max(5000)
})

const formRoutes: Record<string, APIRoute> = {
  '/api/contact': toolkit.createFormRoute({
    schema: contactSchema,
    inspectors: [new toolkit.HoneypotInspector({ fieldName: 'website' })],
    dispatchers: [
      new toolkit.EmailDispatcher({
        transport: recordingTransport,
        templates: toolkit.submissionNotificationTemplates({
          fields: ['name', 'email', 'message'],
          formName: 'Contact form'
        }),
        from: 'site@example.com',
        to: 'owner@example.com',
        replyTo: (submission) => submission.email as string
      })
    ]
  })
}

// MARK: - Request Handling

/** The value of one cookie on a request, or `undefined` when it wasn't sent. */
function readCookie(incoming: IncomingMessage, name: string): string | undefined {
  for (const pair of (incoming.headers.cookie ?? '').split(';')) {
    const [cookieName, ...valueParts] = pair.trim().split('=')
    if (cookieName === name) return decodeURIComponent(valueParts.join('='))
  }
  return undefined
}

/** The Fetch `Request` an Astro route receives for a Node request, with its body read in full. */
async function toFetchRequest(incoming: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue

    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }

  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)

  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD'
  return new Request(url, {
    method: incoming.method,
    headers,
    body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined
  })
}

/**
 * The `APIContext` members a form route reads. Astro's context carries many more, which a route never touches,
 * so this is the one place the partial shape stands in for the whole.
 */
function routeContext(request: Request, incoming: IncomingMessage): APIContext {
  return {
    request,
    url: new URL(request.url),
    site: new URL(FIXTURE_ORIGIN),
    clientAddress: incoming.socket.remoteAddress ?? '127.0.0.1',
    locals: {}
  } as unknown as APIContext
}

/** Write a Fetch `Response` back to Node: its status, headers (a redirect's `Location` among them) and body. */
async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') outgoing.setHeader(name, value)
  })

  // `setHeader` replaces a header, so each `Set-Cookie` must go out together, as one list, or only the last survives.
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) outgoing.setHeader('Set-Cookie', cookies)

  outgoing.end(Buffer.from(await response.arrayBuffer()))
}

/** Send a file from `directoryURL` named by `relativePath`, or a 404 when there's no such file inside it. */
async function serveFile(directoryURL: URL, relativePath: string, outgoing: ServerResponse): Promise<void> {
  const fileURL = new URL(relativePath, directoryURL)
  const contentType = CONTENT_TYPES[extname(fileURL.pathname)]
  if (!fileURL.href.startsWith(directoryURL.href) || contentType === undefined || !existsSync(fileURL)) {
    await writeResponse(new Response('Not found', { status: 404 }), outgoing)
    return
  }

  const body = await readFile(fileURL)
  await writeResponse(
    new Response(new Uint8Array(body), { headers: { 'Cache-Control': 'no-store', 'Content-Type': contentType } }),
    outgoing
  )
}

/** Route one request: a form post, the recorded emails, the built client, the Turnstile fake, or a page. */
async function handleRequest(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const url = new URL(incoming.url ?? '/', FIXTURE_ORIGIN)
  const runId = readCookie(incoming, RUN_COOKIE_NAME) ?? ''

  const formRoute = formRoutes[url.pathname]
  if (formRoute && incoming.method === 'POST') {
    const request = await toFetchRequest(incoming, url)
    const response = await currentRun.run(runId, () => formRoute(routeContext(request, incoming)))
    await writeResponse(response, outgoing)
    return
  }

  if (url.pathname === '/__deliveries' && incoming.method === 'GET') {
    await writeResponse(Response.json(recordedEmailsByRun.get(runId) ?? []), outgoing)
    return
  }

  if (url.pathname.startsWith('/client/')) {
    await serveFile(CLIENT_DIR_URL, url.pathname.slice('/client/'.length), outgoing)
    return
  }

  if (url.pathname === '/turnstile-fake.js') {
    await serveFile(FIXTURE_DIR_URL, 'turnstile-fake.js', outgoing)
    return
  }

  await serveFile(PAGES_DIR_URL, url.pathname.slice(1), outgoing)
}

const server = createServer((incoming, outgoing) => {
  handleRequest(incoming, outgoing).catch((error: unknown) => {
    console.error('[fixture-server] Failed to handle', incoming.method, incoming.url, error)
    if (!outgoing.headersSent) outgoing.statusCode = 500
    outgoing.end()
  })
})

server.listen(FIXTURE_PORT, '127.0.0.1', () => {
  console.log(`[fixture-server] Listening on ${FIXTURE_ORIGIN}`)
})

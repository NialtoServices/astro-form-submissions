// What the fixture server and the browser tests both rely on.

import type { EmailMessage } from '../../../src/index.ts'

/**
 * The fixture server's own port. Playwright starts the server on it for the run and refuses to begin when
 * anything already answers there, so the suite never talks to a developer's server.
 */
export const FIXTURE_PORT = 47123

/** The fixture server's origin, as the browsers reach it. */
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`

/**
 * The cookie naming the test a request belongs to. Every browser shares the one fixture server, so emails are
 * recorded per test run under this cookie, which lets tests run in parallel without seeing each other's emails.
 */
export const RUN_COOKIE_NAME = 'fixture-run'

/** An email as `GET /__deliveries` returns it: the message, with each attachment's bytes as base64. */
export interface RecordedEmail extends Omit<EmailMessage, 'attachments'> {
  attachments?: { filename: string; contentType: string; content: string }[]
}

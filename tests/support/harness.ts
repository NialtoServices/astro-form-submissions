import type { EmailMessage } from '#dispatchers/email.js'
import type { APIRoute } from 'astro'
import { vi, type Mock } from 'vitest'

/**
 * Builds the Astro `APIContext` stub a form route handler receives. Callers pass real typed options
 * (request body/headers/url, client address, configured site) and get a typed context back. Pass
 * `site: null` to model an Astro build with no `site` configured.
 */
export function makeRouteContext(
  overrides: {
    body?: BodyInit
    headers?: HeadersInit
    url?: string
    site?: URL | null
    clientAddress?: string
  } = {}
): Parameters<APIRoute>[0] {
  const url = new URL(overrides.url ?? 'https://example.com/api/form')
  const request = new Request(url, { method: 'POST', body: overrides.body, headers: overrides.headers })
  const site = overrides.site === null ? undefined : (overrides.site ?? new URL('https://example.com'))

  // Astro's APIContext carries many members a route never reads; this stub supplies only the ones the
  // pipeline touches, so the assertion is the single boundary where that partial shape stands in for it.
  return {
    request,
    clientAddress: overrides.clientAddress ?? '1.2.3.4',
    site,
    url,
    locals: {}
  } as unknown as Parameters<APIRoute>[0]
}

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>

/**
 * Installs a `vi.fn` handler as `globalThis.fetch` and returns the mock for call assertions. The
 * handler receives the request URL and init, so a test can capture the outgoing body, return a
 * chosen status, or reject to model a network failure.
 */
export function stubFetch(handler: FetchHandler): Mock {
  const fetchMock = vi.fn(handler)

  // The handler models only the fetch surface these tests exercise; the assertion is the single
  // boundary where that partial function is presented as the global fetch.
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

/** Reads back the {@link EmailMessage} a transport `deliver` mock received on its `index`-th call. */
export function deliveredMessage(deliverMock: Mock, index = 0): EmailMessage {
  return deliverMock.mock.calls[index]![0] as EmailMessage
}

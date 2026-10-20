# Testing charter

**Golden rule: test behaviour, not implementation.** A spec should not care _how_ the code
accomplishes something — only that, given an input, the observable outcome is correct. If a
refactor that preserves behaviour breaks a spec, the spec was wrong.

## What to assert

- **HTTP responses** — status _and_ body (what the sender actually sees).
- **Payloads crossing declared boundaries** — the wire request a transport makes, the
  `EmailMessage` handed to an `EmailTransport`, the embed posted to a webhook.
- **Declared callbacks** — `onError` invocations, template/content callbacks.

## Sanctioned seams

- The wire: **msw** interception, or a `global.fetch` stub where a test must see the exact `fetch` call
  a transport makes (`PostmarkTransport`'s request options, which Cloudflare Workers restricts).
- Stub implementations of **public interfaces**: `Inspector`, `Dispatcher`, `EmailTransport`.
- Hand-built `InspectionContext` objects.
- Public readonly interface properties (`dispatcher.required`) — they are declared contract the route
  consumes.

## Banned

- Spying on constructors or asserting constructor arguments (wiring, not behaviour).
- Asserting how options are stored (e.g. function-identity inspectors on a stored callback).
- Testing private helpers directly — `strings.ts` has no spec on purpose; `clamp`/`humanize` are
  observed through `resolveField` labels and Discord's embed limits. The one exception is a helper
  that implements a published standard, checked against that standard's own examples, which no
  public entry point can reproduce: `sigv4.ts` against AWS's Signature Version 4 vector, and
  `content-disposition.ts` against RFC 6266 and RFC 5987.
- Mocking a module when the wire is observable.
- Snapshot tests and assertions on internal iteration/merge mechanics.

## Properties

Some promises hold for every input, not just the ones an example names: a stored filename is at most
200 characters whatever the browser sent, a body the runtime would parse as text is held to the text limit
whatever its `Content-Type` says. Those are stated as **fast-check** properties.

- A property goes through the same public entry point as the examples, in that entry point's spec file.
  Its generators live in `support/` and weight in the inputs that matter (separators, length caps, odd
  headers), which pure chance would rarely reach.
- Before trusting a new property, reintroduce a bug it should catch and check that it fails, and check that
  its cases reach the paths it claims to cover. A property that passes because its inputs never get past the
  first refusal proves nothing.
- Runs are random. A failure prints its counterexample and seed; replay it with
  `fc.assert(property, { seed, path })`. Once fixed, the counterexample becomes an example test beside the
  property, so it is checked on every run whatever the generator draws.
- Keep each property's `numRuns` affordable: raise it only where a measured bug needs more cases to be
  found reliably.

msw-based files start their own `setupServer`. A file that also stubs `global.fetch` restores the
msw-intercepted `fetch` after each such test, so the two approaches never overlap within a test.

## Browsers

`tests/browser/*.browser.ts` run in Chromium, Firefox and WebKit through Playwright. They cover what DOM emulation
can't prove: real file inputs, drag and drop, focus movement, the multipart body a browser actually sends, direct
uploads with progress, and the same forms with **JavaScript turned off**, posting natively and getting back the
readable responses. Markup-driven logic that happy-dom models faithfully stays in the Vitest suite, where it runs in
milliseconds; a browser test is for behaviour only a real browser can show.

The same golden rule holds: assert what a person sees (visible text, `aria-invalid`, accessible descriptions, focus),
the responses the browser receives, and what the server was sent, never the script's internals.

The suite runs against the **built** package. Its pages load `dist/client/form.js`, and its fixture server
(`tests/browser/fixture/server.ts`) hands each post to a real `createFormRoute` imported from `dist/index.js`, with a
recording `EmailTransport` in place of a provider. A test reads back what its own submissions sent through the
`deliveries` fixture in `tests/browser/support/test.ts`, which tags each test's browser context with a cookie of its
own, so tests run in parallel without seeing each other's emails. Turnstile is `tests/browser/fixture/turnstile-fake.js`,
never Cloudflare's script.

That server is the test run's own: Playwright starts it on port 47123 and stops it when the run ends. It is never a
developer's dev or preview server, and the run fails rather than reuse anything already listening on that port.

```bash
pnpm exec playwright install chromium firefox webkit   # once, and after a Playwright upgrade
pnpm build && pnpm test:browser
pnpm test:browser --project=firefox                     # a single browser
```

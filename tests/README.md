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

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

- The wire: `global.fetch` stubs for code that calls `fetch` directly, or **msw** interception for
  code whose HTTP client is buried in an SDK (`PostmarkTransport`).
- Stub implementations of **public interfaces**: `Inspector`, `Dispatcher`, `EmailTransport`.
- Hand-built `InspectionContext` objects.
- Public readonly interface properties (`dispatcher.required`) — they are declared contract the route
  consumes.

## Banned

- Spying on constructors or asserting constructor arguments (wiring, not behaviour).
- Asserting how options are stored (e.g. function-identity inspectors on a stored callback).
- Testing private helpers directly — `strings.ts` has no spec on purpose; `clamp`/`humanise` are
  observed through `resolveField` labels and Discord's embed limits.
- Mocking a module when the wire is observable.
- Snapshot tests and assertions on internal iteration/merge mechanics.

msw-based files start their own `setupServer`; files that stub `global.fetch` don't mix with msw —
vitest's per-file isolation keeps the two approaches from colliding.

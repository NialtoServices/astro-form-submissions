# @nialto-services/astro-form-submissions

Reusable form-submission machinery for server-rendered Astro sites: a route factory with pluggable
**inspectors** (Cloudflare Turnstile, future spam screening) and **dispatchers** (email via Postmark, Discord
webhooks), plus a client `initializeForms` enhancement that upgrades **your own** form markup (`fetch`
submit, status and per-field errors, Turnstile reset). It works for any form (contact, enquiry,
registration, …) — the toolkit assumes no fields and no vocabulary of its own, and ships no markup.

Field sets, copy, and i18n diverge too much per site, so **you own the form markup**. For the email body
you get a choice: a ready-made generic `submissionNotificationTemplates` (declare a field list, no files to
write) or fully site-owned templates when a site wants its own voice. Either way, the package owns the
plumbing around them.

## Contents

- [Quick start](#quick-start)
- [Install](#install)
- [How it works](#how-it-works)
- [The route](#the-route)
- [Guards](#guards)
- [Inspectors](#inspectors)
- [Dispatchers](#dispatchers)
- [File uploads](#file-uploads)
- [The form (client enhancement)](#the-form-client-enhancement)
- [Styling](#styling)
- [Secrets](#secrets)
- [À la carte and bespoke flows](#à-la-carte-and-bespoke-flows)

## Quick start

Install the package and `zod`:

```bash
pnpm add @nialto-services/astro-form-submissions zod
```

**1. Add an API route** (`src/pages/api/contact.ts`) — a schema, a honeypot, and an email dispatcher
using the ready-made templates:

```ts
import {
  createFormRoute,
  EmailDispatcher,
  HoneypotInspector,
  PostmarkTransport,
  submissionNotificationTemplates
} from '@nialto-services/astro-form-submissions'
import { z } from 'zod'

export const prerender = false

const schema = z.object({
  name: z.string().max(120),
  email: z.email('Please enter a valid email address.').max(200),
  message: z.string().max(5000, 'Message is too long.')
})

export const POST = createFormRoute({
  schema,
  inspectors: [new HoneypotInspector({ fieldName: 'website' })],
  dispatchers: [
    new EmailDispatcher({
      transport: new PostmarkTransport({ token: process.env.POSTMARK_TOKEN! }),
      templates: submissionNotificationTemplates({
        fields: ['name', 'email', 'message'],
        formName: 'Contact form'
      }),
      from: process.env.POSTMARK_FROM!,
      to: process.env.POSTMARK_TO!,
      replyTo: (submission) => submission.email // so replying reaches the sender
    })
  ]
})
```

**2. Write the form** — the package ships no markup, so you own the `<form>` entirely (and style it
with plain scoped CSS). Mark it with the `data-astro-form-*` hooks and enhance it with
`initializeForms`. The honeypot is a hidden input whose `name` matches the `HoneypotInspector`:

```astro
<form data-astro-form action='/api/contact' method='POST'>
  <input type='text' name='website' tabindex='-1' autocomplete='off' hidden />

  <label>Name <input name='name' required /></label>
  <label>Email <input name='email' type='email' required /></label>
  <label>Message <textarea name='message' required></textarea></label>
  <button type='submit'>Send</button>

  <p
    data-astro-form-status
    data-astro-form-message-sending='Sending…'
    data-astro-form-message-success="Thanks — we'll be in touch."
    data-astro-form-message-generic-error='Something went wrong.'
    data-astro-form-message-network-error='Could not reach the server. Please try again.'>
  </p>
</form>

<script>
  import { initializeForms } from '@nialto-services/astro-form-submissions/form'

  initializeForms()
  document.addEventListener('astro:page-load', initializeForms)
</script>
```

That's a working contact form: submissions are validated, screened for the honeypot, and emailed to
you. It reads secrets from `process.env` (Node-based hosts); on Cloudflare Workers they come from a
request-time binding instead (see [The route](#the-route)). The sections below add Turnstile, Discord,
file uploads, and custom error handling.

## Install

Public package (MIT), published to npm with a prebuilt `dist/` — installs are download-and-unpack,
with no install-time build:

```bash
pnpm add @nialto-services/astro-form-submissions zod
```

`astro` is a peer dependency; `postmark` ships as a dependency. Add **`zod`** as a direct dependency
of each site: the toolkit validates through the [Standard Schema](https://standardschema.dev) interface
and never imports Zod itself, so the site brings (and pins) its own. Zod v4 implements Standard Schema
natively; any Standard-Schema-compatible library works, and validation is structural (`~standard`, not
`instanceof`).

> Prefer `import { z } from 'zod'` over borrowing `astro/zod`: pnpm's isolation makes the bundled Zod
> not cleanly importable anyway, your schemas don't shift when Astro bumps its copy, and its planned
> removal of bundled Zod becomes a non-event.

**On Cloudflare Workers only**, `postmark` bundles an HTTP client that can fall back to Node
built-ins, so enable Node compatibility in the site's `wrangler` config for robust email sending
across `workerd` builds (Node-based hosts already have these built-ins):

```toml
compatibility_flags = ["nodejs_compat"]
```

## How it works

The factory runs, in order: **guards** (before the body is read) → read the form data →
**schema** validation → **inspectors** (in order) → **enrichers** (in order) → **dispatchers** (in
parallel). Guards, enrichers, and file uploads are optional — a simple contact form uses only
`schema`, `inspectors`, and `dispatchers`.

<details>
<summary><strong>Which stage does my check go in?</strong></summary>

The five stages aren't distinguished by failure mode (any of them can reject) but by **what they
have** and **what they cost**. Decide in pipeline order — the first stage that can express your check
is usually the right one:

1. **guard** — decidable from the request envelope (headers, IP), and runs **before the body is
   read**. Put anything here that lets you avoid paying to parse a body you'd reject anyway (size cap,
   rate limit, origin/geo gate).
2. **schema** — constructs and validates the one typed submission from the form fields. Field
   presence, formats, length caps, cross-field rules, derived/renamed fields. Failure always rejects.
3. **inspector** — screens an **already-valid** submission; read-only with respect to it (may
   `quarantine` it). Bot verification, spam screening.
4. **enricher** — acquires a resource onto `context.resources` (leaving the submission untouched), with rollback. File uploads.
5. **dispatcher** — delivers (in parallel, terminal).

The inspector→enricher split is deliberate: it makes **"screen before you acquire"** structural —
reject bots before spending storage on their uploads. For a fuzzy edge (an async policy check like a
domain blocklist), decide by desired **failure mode**, not by "does it read a field": fail-open →
inspector, fail-closed → enricher (or fold it into the schema).

</details>

## The route

Add one route per form (e.g. `src/pages/api/contact.ts`). The toolkit reads no environment variables
of its own — you pass secrets in as plain values, so **where they come from stays your choice**. On
Node-based hosts (a Node server, Vercel, Netlify, Deno) read them from `process.env` and build the
route once at module scope:

```ts
import {
  createFormRoute,
  DiscordDispatcher,
  EmailDispatcher,
  HoneypotInspector,
  PostmarkTransport,
  TurnstileInspector
} from '@nialto-services/astro-form-submissions'
import { z } from 'zod'
import * as templates from '@/emails/contact'

export const prerender = false

// The submission's shape, required fields, formats, and per-field copy — all declared here. The
// submission type is inferred from this, so inspectors, dispatchers, and templates stay in sync.
const schema = z.object({
  name: z.string().max(120),
  email: z.email('Please enter a valid email address.').max(200),
  message: z.string().max(5000, 'Message is too long.'),
  company: z.string().max(120).optional()
})

export const POST = createFormRoute({
  schema,
  // Override the copy of a toolkit-owned error (here Turnstile's), keyed by its `key`.
  errors: { verification: 'Please prove you are human and try again.' },
  inspectors: [
    new HoneypotInspector({ fieldName: 'website' }),
    new TurnstileInspector({ secretKey: process.env.TURNSTILE_SECRET_KEY! })
  ],
  dispatchers: [
    new EmailDispatcher({
      transport: new PostmarkTransport({ token: process.env.POSTMARK_TOKEN! }),
      templates,
      from: process.env.POSTMARK_FROM!,
      to: process.env.POSTMARK_TO!,
      replyTo: (submission) => submission.email
      // No acceptsQuarantined, so a quarantined (e.g. spam) submission is withheld from this mailbox.
    }),
    new DiscordDispatcher({
      webhookUrl: process.env.DISCORD_WEBHOOK_URL!,
      fields: ['email'],
      description: (submission) => submission.message,
      acceptsQuarantined: true // the ops channel still gets pinged about flagged submissions
    })
  ]
})
```

For a typed, adapter-agnostic alternative, Astro's
[`astro:env/server`](https://docs.astro.build/en/guides/environment-variables/) exposes the same
values from a schema you declare once, and resolves them from the right source on every adapter.

<details>
<summary><strong>On Cloudflare Workers</strong></summary>

Cloudflare exposes secrets only on a request-time binding — `cloudflare:workers` doesn't resolve at
module scope, and a module-scope `await import` breaks `astro dev` — so read `env` inside the handler
and build the route lazily on first request. Wrap the build in `defineLazyRoute`, which memoises it
(and retries if a build throws) so you don't hand-write the `let route; route ??= …` singleton. Only
the secret source changes; `schema`, `errors`, `inspectors`, and `dispatchers` are identical to above:

```ts
import { createFormRoute, defineLazyRoute } from '@nialto-services/astro-form-submissions'

export const POST = defineLazyRoute(async () => {
  const { env } = await import('cloudflare:workers')
  return createFormRoute({
    schema,
    inspectors: [
      new HoneypotInspector({ fieldName: 'website' }),
      new TurnstileInspector({ secretKey: env.TURNSTILE_SECRET_KEY })
    ]
    // …dispatchers, reading env.POSTMARK_TOKEN, env.POSTMARK_FROM, env.DISCORD_WEBHOOK_URL, …
  })
})
```

</details>

`schema` is where each site's differences live — the field set, which fields are required, the
formats and length caps, and the per-field copy. The toolkit flattens the form data into a trimmed
object (one value per field name, blank/whitespace dropped, file inputs excluded), and validates it.
The validated output **must be an object** — it becomes, verbatim, the one submission every inspector
and dispatcher then works with (a schema that transforms to a scalar/array/null is a misconfiguration
and fails the request closed). Request and site information is not merged into it; each stage instead
receives a context exposing `requestURL` and `siteURL` (see below). There's no separate submission
type to write — it's inferred from the schema, so it can't drift. When a helper needs the type spelled
out (e.g. `submissionNotificationTemplates<T>` or `FileUploads<T>` below), derive it from the schema
rather than re-declaring it — `type ContactEnquiry = z.infer<typeof schema>` (or the toolkit's
`Submission<typeof schema>`).

Derived and renamed fields are the schema's `.transform()` (e.g. a single `name` from `first_name` +
`last_name`); a validation issue's path still points at the original form field, so per-field errors
attribute correctly even after a transform reshapes the payload.

For per-request needs like localized copy, pass a **factory** instead of a value — it receives the
form data and returns the validator:

```ts
createFormRoute({
  schema: ({ data }) => (data.get('lang') === 'fr' ? frenchSchema : englishSchema)
  // …
})
```

### Errors

Errors are **values, not registry keys**: a `FormError` carries a stable `key`, the `status` to
fail with, and its default copy. There is no central list — every error lives with its raiser:

- the route factory's `ERRORS` hold its own failures — `invalidForm`, `send`, `unavailable` — plus the
  schema stage's `validationFailed`, surfaced there so the keys sit together;
- shipped components own theirs (e.g. `TurnstileInspector.errors.verification`,
  `FileUploads.errors.fileTooLarge`).

**Schema validation** is the exception to "every error is a keyed `FormError`". Per-field messages
come straight from your validator (`z.email('Enter a valid email')` or the library's default) — the
toolkit reads only the issue's message and path, so nothing couples to Zod. The one toolkit-owned key
here is `validationFailed`, the **always-generic, presentation-neutral summary** for a validation
failure of one field or many; the detail lives in `fieldErrors`. Override its copy via
`errors.validationFailed` like any keyed error. See [Presenting errors](#presenting-errors).

The site's `errors` option overrides copy **by key** for the toolkit-owned errors above — one hook
for tone and i18n, whichever component raised the error. It is either a static map, or a **resolver**
for localization that reads the request:

```ts
// Static: substitute copy per key.
errors: {
  verification: 'Please prove you are human.'
}

// Resolver: localize by reading a `lang` field. Return undefined to keep the default.
errors: (key, _default, { data }) => strings(data?.get('lang')).errors[key]
```

The resolver applies uniformly to every toolkit-owned error (route / Turnstile / uploads /
`validationFailed`) — **not** to your schema's own field messages (localize those inside the schema,
via a factory). One caveat: pre-body guard errors (rate-limit) reject before the body is
read, so the resolver receives no `data` and falls back to default-locale copy.

### Options

| Option        | Default         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guards`      | `[]`            | Gates run before the body is parsed; each may pass, quarantine, reject, or drop (see [Guards](#guards)).                                                                                                                                                                                                                                                                                                 |
| `schema`      | —               | Required. A Standard Schema validator (or a factory returning one) that validates and shapes the submission.                                                                                                                                                                                                                                                                                             |
| `inspectors`  | `[]`            | Inspections run in order; each may accept, quarantine, drop, or reject (see below).                                                                                                                                                                                                                                                                                                                      |
| `enrichers`   | `[]`            | Resource acquisition run after inspectors; each provides a resource onto `context.resources` and can roll back (see [Uploads](#file-uploads)).                                                                                                                                                                                                                                                           |
| `dispatchers` | `[]`            | Delivery destinations run in parallel; a quarantined submission reaches only those with `acceptsQuarantined`.                                                                                                                                                                                                                                                                                            |
| `errors`      | `{}`            | Per-site copy overrides by error key (see [Errors](#errors)).                                                                                                                                                                                                                                                                                                                                            |
| `onError`     | `console.error` | Called on a swallowed guard/inspection/enrichment/delivery/unexpected error, so failures reach logs. The default logs a **PII-safe summary** (stage, error class, any `code`/`status`) — never the error's message/object, since provider errors can quote submission data (e.g. a `Reply-To`). Override it to log the full error where your pipeline can hold that PII, or to forward structured codes. |

## Guards

A guard runs **before the request body is parsed**, so it sees only the request envelope (headers,
URL, client address) — a cheap gate that avoids paying to parse a body it will reject anyway. It
returns the same `Verdict` an inspector does: `{ action: 'accept' }`, `{ action: 'quarantine', reason? }`
(withhold delivery from all but the `acceptsQuarantined` destinations — e.g. a geo or IP-reputation
block that should still reach an ops channel), `{ action: 'reject', error }`, or `{ action: 'drop' }`
(silent success). Like an
inspector, a throwing guard **fails open** by default (reported via `onError`, then skipped) so a
broken guard can never block every submission. A guard whose threat model can't tolerate being
skipped on a bug — an origin allowlist, a geo-block — sets `failClosed: true`, and an unexpected
throw then fails the request (`500 unavailable`) instead of being skipped. Keep it off for cheap or
peripheral gates: a transient limiter-backend blip must not `500` every enquiry.

One ships with the package:

- `RateLimitGuard({ limiter, key? })` throttles per request, rejecting `rateLimited` (429). `limiter`
  is anything implementing `RateLimiter` (`{ limit({ key }) → { success } }`), so any backing store
  works. The bundled `InMemoryRateLimiter({ limit, windowSeconds, maxKeys? })` is the batteries-included
  option — a fixed-window counter that needs no external service, but is **per-isolate and
  non-durable**, so it is correct only for local dev or a single long-lived instance (multi-instance/serverless deployments
  need a shared store — a Cloudflare rate-limit binding, Redis, Upstash, or a Durable Object — since
  each isolate otherwise keeps its own counts). It keys by client address by default. **Fails open**: a
  limiter outage never blocks a submission (and a Cloudflare binding is simply a no-op under `wrangler
dev`, where `InMemoryRateLimiter` still throttles). With the default key and no resolvable client
  address it also fails open (rather than throttle every address-less caller against one shared bucket)
  — pass `key` to throttle those on another dimension. Its key map is **bounded** — elapsed windows are
  swept and the map is capped at `maxKeys` (default 100k) — so a flood of distinct keys (e.g. spoofed
  addresses) can't grow memory without limit; at the cap the oldest key is evicted, degrading the limit
  gracefully rather than exhausting the isolate.

```ts
// InMemoryRateLimiter is an easy default; swap in a Cloudflare binding (env.CONTACT_LIMITER),
// Redis, Upstash, or a Durable Object for a shared store across instances in production.
guards: [new RateLimitGuard({ limiter: new InMemoryRateLimiter({ limit: 5, windowSeconds: 60 }) })]
```

**A route that accepts uploads must set a true ceiling at your host's edge** (e.g. a Cloudflare
request-body limit or WAF rule, an Nginx `client_max_body_size`); the authoritative per-file/total
caps live in `FileUploads`. No guard can enforce a real body cap — the declared `Content-Length` can
be absent, chunked, or understated, and a guard can't consume the stream the route later parses. Where
a cheap refusal for honest clients is worth it, a few lines gate the declared length as a fast path,
**not a cap**:

```ts
import { formError, type Guard } from '@nialto-services/astro-form-submissions'

const contentLengthGuard: Guard = {
  guard: async (context) => {
    const declaredBytes = Number(context.request.headers.get('content-length'))
    if (declaredBytes > 50 * 1024 * 1024)
      return { action: 'reject', error: formError('requestTooLarge', 413, 'Your submission is too large.') }

    return { action: 'accept' }
  }
}
```

## Inspectors

An inspector inspects the submission before delivery and returns a `Verdict` — one of:

- **accept** (`{ action: 'accept' }`) — continue; on full acceptance the submission delivers to every
  dispatcher.
- **quarantine** (`{ action: 'quarantine', reason? }`) — the sender still sees success, but delivery is
  **withheld from every dispatcher except those that opt in via `acceptsQuarantined`** (an ops channel,
  say). This is the safe, self-executing spam mechanism: a screener flags a submission and the routing
  happens automatically — customer-facing dispatchers default to `acceptsQuarantined: false`, so spam
  never reaches them by construction. The verdict is **non-terminal** (later inspectors still run), and
  an optional `reason` accumulates across stages into `context.quarantineReasons`. A later `drop` or
  `reject` still short-circuits and wins.
- **drop** (`{ action: 'drop' }`) — silent stop; the sender sees success but nothing is delivered
  (e.g. a honeypot or hard blocklist — never tip off a spammer).
- **reject** (`{ action: 'reject', error: formError('verification', 400, '…') }`) — hard stop; the sender
  sees the error's copy and status (copy overridable per-site via `errors[key]`).

An inspector that **throws** is treated as unexpected: it's reported via `onError` and skipped
(fail-open) by default, so a flaky inspector can never reject every submission. An inspector that must
fail closed on its _own expected_ failures — like `TurnstileInspector` — catches them and returns
`{ reject }`. One whose threat model can't tolerate being skipped on a _bug_ sets `failClosed: true`,
so an unexpected throw fails the request (`500 unavailable`) rather than silently skipping the check.

<details>
<summary><strong>Design note: failure modes by stage</strong></summary>

> **Failure-mode by stage.** Screening stages (guards, inspectors) default **open** with `failClosed`
> to opt in; effectful stages (enrichers, dispatchers) default **closed** with their own opt-outs
> (`acceptsQuarantined`, non-`required`). The default tracks the stage family; the flag lets you override
> for your threat model.

</details>

Two inspectors ship with the package:

- `HoneypotInspector` silently drops submissions whose honeypot field is filled. `fieldName` is
  required and must match the `name` of the honeypot `<input>` you render in your form — pick a name a bot will fill
  but the site never legitimately collects (there is no safe default: `website` could be a real
  field on some forms). Place it **first** in `inspectors` so bots are dropped before more expensive
  inspectors run.
- `TurnstileInspector` verifies a Cloudflare Turnstile token server-side. **Optional hostname
  binding** via `verifyHostname` additionally rejects tokens solved on an untrusted host —
  defence-in-depth against replay from the public sitekey, on top of the allowed-domains you set on
  the widget in the Turnstile dashboard (that dashboard config is the primary control, and is what
  lets the widget render on each origin in the first place). `verifyHostname` takes:

  - `false` / omitted (**default**) — off.
  - `true` — verify against Astro's `site`.
  - a hostname **string** — verify against exactly that host.
  - a **`string[]`** — accept a token solved on any listed host, so a site reachable on more than one
    origin works. A literal `[]` is a closed allowlist that rejects everything (reported once).

  ```ts
  new TurnstileInspector({
    secretKey: process.env.TURNSTILE_SECRET_KEY!,
    verifyHostname: ['example.com', 'staging.example.com'] // production + a preview/staging origin
  })
  ```

  Add each such host to the widget's allowed domains too, or the widget won't solve there. Binding
  never falls back to the request-derived host (which a spoofed `Host` header can influence on some
  adapters) — with it enabled and no trusted hostname available (or an invalid one), every submission
  is rejected and the misconfiguration reported via `onError`. Operational failures (Cloudflare
  outage, rotated/invalid secret, contract change) are also reported via `onError` with
  `stage: 'inspection'` while senders still see the generic rejection, so a total form outage is
  diagnosable from logs. Expected token invalidity stays silent.

  **Visitor IP (sent by default).** `sendRemoteIP` **defaults to `true`**, so whenever Astro exposes a
  client address the inspector forwards it to Cloudflare Siteverify as `remoteip` — it sharpens bot
  detection. This is a personal-data transfer to a third party that happens **unless you opt out**: set
  `sendRemoteIP: false` to withhold it (Siteverify still verifies the token without it). Make it a
  conscious choice — record a lawful basis for the transfer, or turn it off.

A future spam screener is just an inspector returning `{ action: 'quarantine', reason: 'casino' }` — the route needs no changes, and flagged submissions are withheld from every customer-facing dispatcher automatically.

Writing your own inspector? Never hardcode which submission fields it reads — field names are
site-specific. Take them as options and read `context.submission[name]` (or `context.data` for the
raw form): a single-field check mirrors `HoneypotInspector`'s required `fieldName`, and a multi-field
analyser (e.g. a spam scorer) takes a required `fields: (keyof E & string)[]` option with no default.
The only sanctioned built-in defaults are protocol-level, not business fields — `TurnstileInspector`'s
`cf-turnstile-response` token and `FileUploads`' `'file'`.

## Dispatchers

A dispatcher is a delivery destination. All dispatchers run in parallel. A `dispatch` call that
**resolves counts as a delivery** and a throw as a failure — there is no "resolved but skipped" state,
so never early-`return` to skip; a quarantined submission is withheld by the route (see
`acceptsQuarantined` below) before `dispatch` is called. Each carries these knobs:

Every dispatcher callback receives `(submission, context)`. The submission is exactly the schema's
validated output — nothing is merged onto it. The **context** carries the request/site information
each stage's context exposes: `quarantined` (whether an inspector/guard flagged this submission — you
only see it here if this dispatcher opted in) and `quarantineReasons` (the accumulated reasons, empty
when not quarantined), plus two raw URLs — `requestURL` (the current request's URL, always present,
whose host a proxy or client can influence) and `siteURL` (Astro's configured `site`, the **trusted
origin**, or `undefined` when unset). Derive whatever you need and pick your own trust/fallback — e.g.
a display host as `(context.siteURL ?? context.requestURL).hostname`, or a hostname bound strictly to
the trusted `context.siteURL`.

- **`acceptsQuarantined`** — whether this destination receives quarantined submissions. **Default
  `false`**, so the pipeline is safe by construction: a submission an inspector quarantines (e.g. spam)
  reaches a destination only by explicit opt-in. Customer-facing dispatchers leave it unset and never
  receive junk; set it `true` on an internal/ops destination (owner notification, ops Discord) that
  should still see flagged submissions — where it can surface `context.quarantineReasons`:

  ```ts
  new EmailDispatcher({ … })   // acceptsQuarantined defaults false → client never receives junk
  new DiscordDispatcher({
    …,
    acceptsQuarantined: true,   // the ops channel still pings on flagged submissions
    title: (_submission, context) =>
      context.quarantined ? `Blocked (${context.quarantineReasons.join(', ')})` : 'New submission'
  })
  ```

- **`required`** — marks the dispatcher load-bearing: if its delivery throws, the sender gets a 502 and
  can retry, even when other dispatchers succeeded. Non-required dispatcher failures are logged via `onError`
  and the sender still sees success — **unless every attempted delivery failed**, in which case the
  route returns a 502 regardless of `required` (a total outage must never report "sent").
  Quarantine skips don't count as failures, so a submission withheld from every destination (e.g.
  spam with no ops channel) still gets its silent 200 — and the route logs one `onError` warning so a
  quarantine that reaches nothing is diagnosable rather than a silent black hole. Defaults:
  `EmailDispatcher` **required**, `DiscordDispatcher` **best-effort**. A Discord-only site flips the default:

  ```ts
  dispatchers: [new DiscordDispatcher({ webhookUrl, fields: ['email'], required: true })]
  ```

- **`exposesResources`** — whether this delivery carries the enrichers' acquired resources (uploaded-file
  links) to a recipient who then needs them to persist. It decides upload rollback: files are kept when
  an exposing delivery succeeds (deleting them would leave dead links) and rolled back when none does.
  For `EmailDispatcher` this now **derives from the templates**: the built-in
  `submissionNotificationTemplates` / `submissionAcknowledgementTemplates` mark themselves as exposing
  resources exactly when you give them an `attachments` field to render — so a plain acknowledgement with
  no `attachments` is `false` and never orphans files, while a notification that lists uploads is `true`,
  and you rarely set the flag by hand. `DiscordDispatcher` defaults **false** (an internal ping). So a
  failed attachment email whose Discord sibling succeeded still rolls the files back rather than orphaning
  them. The explicit flag remains the override — set it for hand-written templates (which default to
  `true`) that omit the links, or for a Discord embed that itself links the uploads
  (`exposesResources: true`). Resolution is explicit option → template marker → `true`.

- **`deliverWhen`** — a per-submission opt-out `(submission, context) => boolean`. Return `false` and
  the route skips this destination for that submission — a no-op like a quarantine skip: **neither a
  delivery nor a failure**, so it never counts toward the "every attempted delivery failed → 502" rule
  and never marks resources exposed. Omitted ⇒ always deliver. Use it for conditional delivery — e.g. an
  acknowledgement email only when the sender left an address (the `to` resolver still needs to yield a
  string, so pair it with a `?? ''` fallback rather than a non-null assertion):

  ```ts
  new EmailDispatcher({
    templates: acknowledgementTemplates,
    to: (submission) => submission.email ?? '', // dead branch — deliverWhen gates it
    deliverWhen: (submission) => Boolean(submission.email),
    required: false
  })
  ```

Note: because dispatchers run in parallel, a required-dispatcher failure (→ 502 → the sender retries) may fire
best-effort dispatchers again — a duplicate Discord ping is the accepted trade-off for no ordering
complexity.

### Email

`EmailDispatcher` owns everything email-generic — your `templates` (`subject`/`text`/`html`),
rendering, addressing (`from`/`to`/`replyTo`), and delivery policy — and delegates the wire call to an
`EmailTransport`. `PostmarkTransport` is the bundled provider (`{ token, messageStream?, timeoutSeconds? }`);
adding Resend/SES later means implementing `EmailTransport` (~10 lines of API mapping) while templates
and addressing stay put.

**Addresses live on the dispatcher, not the templates** (the templates only render content). `from`
and `to` are each a fixed string **or** a `(submission) => string` resolver; `replyTo` is the same but
may resolve to `undefined` to omit the header — e.g. `replyTo: (submission) => submission.email` routes
replies to the sender. A `to` resolver is also what lets a second dispatcher address the sender to
acknowledge them (see [Acknowledging the sender](#acknowledging-the-sender)).

#### Templates

`templates` is three functions (`subject`/`text`/`html`), with three ways to produce them — quickest first.

**Quick compose** — for the standard "here's what they submitted" email, declare the field list
(same spec as the Discord `fields`: bare keys humanise, empties drop) and skip template files
entirely:

```ts
templates: submissionNotificationTemplates<ContactEnquiry>({
  fields: ['name', 'email', 'phone', 'company', 'message'], // a free-text field is just a field
  formName: 'Contact form', // the email's title; also appears in the subject and preview
  brandName: 'Acme Ltd' // optional wordmark above the card (replyTo/from/to live on the EmailDispatcher)
  // subject: 'New enquiry from {{name}}'  — default mentions formName and the site host (siteURL, else the request host)
  // submittedAt: (submission, context) => …  — meta-line timestamp; defaults to the submission's arrival time (stamped once per request and shared by every stage, so all emails for one submission agree), formatted in UTC
  // attachments: 'files'  — renders the FileLink[] a FileUploads enricher exposed on context.resources.files (needs <ContactEnquiry, 'files'>)
  // copy: { … }  — override the template's fixed UI copy (see "Translating the copy" below)
})
```

There's no special "message" field — list a textarea key (`message`, `requirements`, …) in `fields`
like any other; values render with their line breaks preserved. The HTML version is a
self-contained, dark-mode-aware, Outlook-safe document; the text version mirrors it. Both live as
`submission-notification.html.mustache` / `.txt.mustache` in this package's top-level `templates/` folder.

**Translating the copy.** Both built-in templates (this one and the acknowledgement below) take a
`copy` option that overrides their fixed UI text — the eyebrow, title (`heading`), footer note, and
the `Attachments` label — so a localized site reuses the **same HTML shell** in another
language. The footer links the site URL (`https://example.com/`) on its own line beneath the note, with
no label to translate. The dynamic content (fields, subject, and the acknowledgement's `greeting`/`message`) is
already yours; `copy` covers the chrome:

```ts
copy: {
  heading: 'Nouveau message',
  footerText: 'Ceci est une notification automatique.',
  attachmentsLabel: 'Pièces jointes'
}
```

**Site-owned copy** — write the copy in Rails-mailer-style files
(`<name>.html.mustache` / `<name>.txt.mustache`) and let the bundled Mustache producer
build them:

```ts
import { mustacheTemplates } from '@nialto-services/astro-form-submissions'
import htmlSource from './contact-mailer.html.mustache?raw'
import textSource from './contact-mailer.txt.mustache?raw'

export const templates = mustacheTemplates<ContactEnquiry>({
  subject: 'New enquiry from {{name}} via {{siteHost}}',
  html: htmlSource,
  text: textSource,
  // The submission carries no site host; surface one from the context for the template.
  view: (submission, context) => ({ ...submission, siteHost: context.siteURL?.hostname })
})
```

Vite's `?raw` inlines the files as strings at build time, so nothing touches the filesystem at
runtime. `{{value}}` is HTML-escaped in the `html` source but left raw in `subject`/`text` (they
aren't HTML documents); `{{{value}}}` passes trusted markup through; `{{#field}}…{{/field}}`
sections render optional fields without leaving blank lines. Mustache is logic-less by design —
computed presentation values (like the site host above) go through the optional `view` transform,
which also receives the dispatch context, not the template — and
interpreted (no `eval`), so it runs even on restricted runtimes like `workerd` (Cloudflare Workers)
and other edge runtimes, where compiling engines (Handlebars, EJS) can't.

**Any other engine** — implement the three `EmailTemplates` functions with it (JSX via
`preact-render-to-string`, whatever suits the site) — the dispatcher never knows the difference.

#### Acknowledging the sender

To email the person who submitted — a "thanks, we got it" confirmation — add a **second**
`EmailDispatcher` addressed to them. `submissionAcknowledgementTemplates` is the ready-made
counterpart to `submissionNotificationTemplates`: a warm confirmation with a copy of what they sent.

```ts
new EmailDispatcher({
  transport: new PostmarkTransport({ token: process.env.POSTMARK_TOKEN! }),
  templates: submissionAcknowledgementTemplates<ContactEnquiry>({
    fields: ['name', 'email', 'message'], // optional — omit for a plain "thanks" with no copied fields
    formName: 'Contact form',
    greeting: (submission) => `Hi ${submission.name},`, // optional; field names are yours, so no default
    message: "Thanks — we'll reply within one working day.", // optional; overrides the default line
    contact: { email: 'support@acme.com', address: '1 High St, London' } // optional in-card contact details
  }),
  from: process.env.POSTMARK_FROM!,
  to: (submission) => submission.email, // ← the sender (schema-validated), via the `to` resolver
  replyTo: () => process.env.SUPPORT_EMAIL!, // so a reply reaches you, not a no-reply address
  required: false // a failed courtesy email must not fail the submission
  // acceptsQuarantined is omitted, so it defaults false — a flagged spam submission is never acknowledged.
  // exposesResources is derived automatically: no `attachments` field here, so it defaults to false
})
```

It runs in parallel with your inbox notification — **no pipeline change, just another dispatcher**.
Two knobs matter here: `to` is a resolver so it reaches the sender (see [Email](#email)), and
`required: false` keeps a bounced courtesy email from failing an otherwise-delivered submission. The
copy is translatable via the same `copy` option shown above; `greeting` and `message` cover the body.

`fields` is **optional** here (unlike the notification): omit it for a bare "thanks" — the copied-back
submission block and its divider vanish, leaving just your `message`. `contact` adds a contact block
in the card (`email` as a `mailto:` link, `phone`, `address`) — each line omitted unless given, so the
whole block stays absent by default.

### Discord

`DiscordDispatcher` posts each submission to a webhook as an embed. **`fields` is required** — the
field set differs per site, so the dispatcher never guesses which fields exist; you declare which
appear and in what order. Three forms, from simplest to most flexible (pass `[]` for a
title-and-description-only embed):

```ts
// 1. Bare submission keys. Label is humanised (`preferredTime` → "Preferred Time"),
//    inline by default, and a field is dropped when its value is empty/absent.
fields: ['email', 'phone', 'company']

// 2. Specs — override the label, compute a value (with the context), or make a field full-width.
fields: [
  'email',
  { key: 'enquiryType', label: 'Type' },
  { label: 'Full name', value: (submission) => submission.name, inline: false }
]

// 3. A builder function, for anything the above can't express.
fields: (submission, context) => [{ name: 'Site', value: context.siteURL?.hostname ?? '' }]
```

`title`, `description`, and every field `value` receive `(submission, context)`, so notifications
can surface the quarantine disposition (`context.quarantined` / `context.quarantineReasons`) or
request/site info however the site likes. Embed limits (title/field/total lengths, field count) are
clamped automatically so an oversize submission can never make Discord reject the notification.

## File uploads

A form takes files by adding a file input to your form — `<input type="file" name="file"
multiple />`. The enhancement already submits multipart, and the route already receives the files;
what's left is to store them and expose download links to the dispatchers. That's an **enricher**: it
runs after the inspectors (so an unverified/bot caller never triggers an upload), validates the
files, moves them to storage, and exposes the resulting links on `context.resources` — with
**rollback**, so if delivery later fails the stored objects are deleted rather than orphaned.

> **Storage today is Cloudflare R2.** `R2Storage` is the only shipped `FileStorage` adapter, so the
> examples below use a Cloudflare R2 binding — `env` is the request-time binding from
> [The route](#the-route)'s Cloudflare note. `FileStorage` is a small `put`/`get`/`delete` interface,
> so another backend (S3, a dev disk, …) is one adapter away.

```ts
import { ALL_TYPES, createFormRoute, EmailDispatcher, FileUploads, R2Storage, signedLink, submissionNotificationTemplates } from '@nialto-services/astro-form-submissions'

// …inside the route config…
enrichers: [
  new FileUploads<Enquiry>({
    storage: new R2Storage({ bucket: env.UPLOADS_BUCKET, prefix: 'uploads/' }),
    maxFiles: 5,
    maxFileBytes: 10 * 1024 * 1024,
    accept: ALL_TYPES,                                   // magic-byte allow-list (IMAGE_TYPES, DOCUMENT_TYPES)
    link: signedLink({ secret: env.UPLOADS_LINK_SECRET, ttlSeconds: 7 * 24 * 60 * 60 }),
    attachTo: 'files'                                    // the `context.resources` key the links land on
  })
],
dispatchers: [
  new EmailDispatcher({ …, templates: submissionNotificationTemplates<Enquiry, 'files'>({ …, attachments: 'files' }) })
]
```

The enricher does **not** mutate the submission — the submission stays exactly the schema's validated
input. The resolved `FileLink[]` is exposed to the dispatchers on **`context.resources[attachTo]`**
(here `context.resources.files`), and a dispatcher declares it needs that resource by naming the key
(the email templates' `attachments: 'files'`). The route type-checks the two against each other: an
email that reads `files` only compiles when some enricher provides `files`. Because naming the resource
key needs a second type argument, pass both to the template builder — `submissionNotificationTemplates<Enquiry, 'files'>`
— when the submission type is explicit (giving only `<Enquiry>` leaves the key at its `never` default).

**Keep the limits in one place.** The client file UI you write (the `<input accept>`, any
pre-submit size/count check, the error copy) must agree with the server's `maxFiles` / `maxFileBytes`.
Declare them once in a module both import — e.g. `src/lib/contact-limits.ts` exporting `MAX_FILES` /
`MAX_FILE_BYTES` — rather than re-typing the numbers in the endpoint and the `.astro` script, where
they drift. The package also exports the enricher's own defaults (`DEFAULT_MAX_FILES`,
`DEFAULT_MAX_FILE_BYTES`, `DEFAULT_MAX_TOTAL_BYTES`) if you want to reference them.

Files are **content-sniffed by magic bytes** (never the client MIME), so a renamed executable is
rejected; validation failures return `tooManyFiles` / `fileTooLarge` / `fileType`. The links are
signed, tamper-proof, and non-guessable — serve them from a companion route (`defineLazyRoute` handles
the Cloudflare request-time binding, as for the form route):

```ts
// src/pages/files/[token].ts
export const GET = defineLazyRoute(async () => {
  const { env } = await import('cloudflare:workers')
  return createFileRoute({
    storage: new R2Storage({ bucket: env.UPLOADS_BUCKET, prefix: 'uploads/' }),
    secret: env.UPLOADS_LINK_SECRET
  })
})
```

`createFileRoute` verifies the token (404 on a bad or **expired** one, 410 once the object is gone)
and streams the file with an `attachment` disposition and `nosniff`, so an allowed-but-hostile file
can never execute in the browser. The signing secret is a per-site secret (e.g. a `wrangler secret`,
or your host's secret store) of **at least 32 characters** — `signedLink` and `createFileRoute` reject
a shorter one at construction, since HS256's safety rests entirely on it; rotating it invalidates every
issued link.

**Retention.** Tokens are **opaque** — they carry only the storage key and an expiry, never the
filename or content-type (a JWT body is base64url, decodable by anyone holding the URL); the download
route reads the filename/type back from stored metadata. Two independent lifetimes bound exposure, and
you own both:

- **Link lifetime** — `signedLink`'s `ttlSeconds` (default 7 days) caps how long a leaked bearer link
  stays usable, independently of storage.
- **Object lifetime** — set a bucket **lifecycle rule** scoped to the `prefix` (e.g. R2's) to delete
  old uploads. Keep it **at least** as long as `ttlSeconds` so a valid link's object still exists, and
  no longer than your retention policy for the personal data those files may contain.

> **A lifecycle rule is required for production.** The toolkit enforces no object TTL of its own, and a
> link expiring never removes the stored file — only the bucket's lifecycle (or an explicit delete)
> does. **Without a lifecycle rule, uploaded files — personal data — persist in the bucket
> indefinitely**, so configuring one is a deployment step, not an optimisation.

**Servicing an erasure request.** `FileStorage` exposes `delete(key)` — implemented by `R2Storage`,
and the same call the enricher's rollback uses — so removing a specific stored file on demand (e.g. a
data-subject deletion request) is a supported operation, not only a console action. It takes the bare
logical key the file was stored under (`R2Storage` applies the `prefix`); persist that key alongside
your submission record if you need to honour deletion requests programmatically, or delete the object
directly from the bucket under the `prefix`.

A rolled-back or lifecycle-expired object simply 410s. Deletion/erasure of stored uploads is the
bucket's job; the toolkit never retains the files or the bearer URLs itself.

## The form (client enhancement)

The package ships **no markup** — you write the `<form>` and its fields, mark it with the
`data-astro-form-*` hooks below, and call `initializeForms` to progressively enhance it. Because the
DOM is entirely yours, you style it with ordinary scoped CSS: **no `:global`, and no package class
names to memorise.** The only contract is the data attributes, which are behavioural hooks, not
styling handles.

```astro
<form data-astro-form action='/api/contact' method='POST'>
  <input type='text' name='website' tabindex='-1' autocomplete='off' hidden />

  <label>Name <input name='name' required /></label>
  <label>Email <input name='email' type='email' required /></label>
  <label>Message <textarea name='message' required></textarea></label>
  <button type='submit'>Send</button>

  <p
    data-astro-form-status
    data-astro-form-message-sending='Sending…'
    data-astro-form-message-success="Thanks — we'll be in touch."
    data-astro-form-message-generic-error='Something went wrong.'
    data-astro-form-message-network-error='Could not reach the server. Please try again.'>
  </p>
</form>

<script>
  import { initializeForms } from '@nialto-services/astro-form-submissions/form'

  initializeForms()
  document.addEventListener('astro:page-load', initializeForms)
</script>
```

The enhancement submits via `fetch`, shows the message copy in the status element (announced to
screen readers), guards against double-submits, and re-initialises on Astro View Transitions
(`astro:page-load` — hence the listener). Standard submit semantics are preserved: any submit control
works (`<button>`, `<input type="submit">`, multiple named controls), and the clicked control's
name/value joins the payload. Requests are bounded by a 30-second timeout (override per form with a
`data-astro-form-submit-timeout` attribute, in milliseconds — a non-positive or non-finite value is
ignored and the default kept); a timeout shows the network-error copy.
Success requires the route's `{ ok: true }` body — any other 2xx response is treated as an error.

### The contract

`initializeForms` enhances every `[data-astro-form]` form in the document (safe to call repeatedly).
Each hook is an attribute you add to your own markup:

| Attribute                                                               | On                              | Purpose                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `data-astro-form`                                                       | the `<form>`                    | Marks the form for enhancement. **Required.**                                                                            |
| `data-astro-form-status`                                                | an element inside the form      | The live region for status copy; also receives `data-astro-form-state` of `pending` / `success` / `error`. **Required.** |
| `data-astro-form-message-{sending,success,generic-error,network-error}` | the status element              | Client transport copy (see below).                                                                                       |
| `data-astro-form-success`                                               | an element right after the form | Optional — swap the whole form out for it on success (see [Swap on success](#swap-on-success)).                          |
| `data-astro-form-field-error-for="<name>"`                              | an element beside a field       | Optional co-located error slot (see [Presenting errors](#presenting-errors)).                                            |
| `data-astro-form-field-error-summary`                                   | an element inside the form      | Optional central error list (see [Presenting errors](#presenting-errors)).                                               |
| `data-astro-form-submit-timeout`                                        | the `<form>`                    | Optional per-form request timeout, in ms (default 30000).                                                                |

The `data-astro-form-message-*` copy is a **different layer** from the server's `FormError` copy:
these are client transport states the server never sees — sending (in-flight), success (delivery
confirmed), generic-error (the fallback when the server body carries no `error` string), network-error
(the request never completed). A business rejection's copy comes from the server's `FormError`
(`error`, and per-field `fieldErrors`); the client prefers it and only falls back to the message
attributes. Don't conflate the two.

The `initializeForms` module is plain client TypeScript imported from
`@nialto-services/astro-form-submissions/form`; your Astro build bundles it into the page's client JS
like any other `<script>`.

### Extras: honeypot and Turnstile

Two optional protections need **extra markup in your form** — nothing is auto-rendered:

- **Honeypot.** Add a hidden text input whose `name` matches the `HoneypotInspector`'s `fieldName`,
  and place the inspector first server-side:

  ```astro
  <input type='text' name='website' tabindex='-1' autocomplete='off' hidden />
  ```

- **Turnstile.** Add Cloudflare's loader to the page `<head>`, render the widget container **inside
  your form**, and add the `TurnstileInspector` server-side. If the loader is absent the form still
  submits — the widget reset is simply skipped.

  ```html
  <!-- in <head> -->
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  ```

  ```astro
  <!-- inside the <form> -->
  <div class='cf-turnstile' data-sitekey={import.meta.env.PUBLIC_TURNSTILE_SITE_KEY}></div>
  ```

  `.cf-turnstile` is Cloudflare's own class (its loader looks for it); the enhancement finds it there
  to reset the widget after success **and** after failed attempts, so a retry never resubmits an
  already-consumed token.

### Swap on success

By default a successful submission shows the success copy in the status element and resets the form.
To replace the form entirely instead, add an element carrying `data-astro-form-success` **immediately
after** the form — keep it hidden — and on success the whole `<form>` is swapped out for it (and
focused, so screen readers announce it):

```astro
<form data-astro-form action='/api/contact' method='POST'>
  <input type='text' name='website' tabindex='-1' autocomplete='off' hidden />
  <label>Name <input name='name' required /></label>
  <button type='submit'>Send</button>
  <p data-astro-form-status data-astro-form-message-generic-error='Something went wrong.'></p>
</form>
<div data-astro-form-success role='status' tabindex='-1' hidden>
  <h2>Thanks — we'll be in touch!</h2>
</div>
```

### Events

For anything bespoke (redirects, analytics, custom swaps), the form emits bubbling events:

- `astro-form:success` — after a successful submission, dispatched **before** any swap so
  `event.target` is the still-mounted form; `detail.data` is the submitted `FormData`.
- `astro-form:error` — after a failed or unreachable submission; `detail.error` is the summary shown
  to the user and `detail.fieldErrors` is the per-field map (empty for non-validation errors). Build
  a fully bespoke error UI (e.g. a clickable error summary linking to each field) from this.

```ts
document.addEventListener('astro-form:success', (event) => {
  plausible('Form Submitted', { props: { form: (event.target as HTMLFormElement).id } })
})
```

### Presenting errors

On a validation failure the server emits `{ error: <generic summary>, fieldErrors: { name: '…' } }` — the
same shape whether one field or many; other rejections carry just `{ error }`. On any rejection the client sets the status region to the summary
(`data-astro-form-state="error"`) and marks each faulty input `aria-invalid="true"`. It then renders
`fieldErrors` into **whichever surfaces the markup provides** — the same payload drives all of them,
so the site opts in by which elements it renders, no config flag:

**Highlighted inputs** (the baseline). Render nothing extra; style the marked inputs and the client
focuses the first one:

```css
[data-astro-form] input[aria-invalid='true'] {
  border-color: var(--color-red);
}
```

**Co-located messages.** Drop an error slot beside a field and the client fills it, links it via
`aria-describedby`, and unhides it:

```astro
<label>Email <input id='contact-email' name='email' type='email' /></label>
<p data-astro-form-field-error-for='email' id='contact-email-error' hidden></p>
```

**Central summary list** (an error overview). Drop a `[data-astro-form-field-error-summary]` element and the
client fills it with a list of every field's message, each linking to its field, and focuses it:

```astro
<div data-astro-form-field-error-summary hidden></div>
```

Mix freely — inline, central list, both, or neither. Field marks (and both surfaces) clear on the
next submit and per-field as the user edits a flagged field (progressive recovery); an
`aria-describedby` the client added is removed on recovery, while an author-authored one is left
intact.

A site wanting something fully bespoke can skip all three and build its own UI from the
`astro-form:error` event (`detail.error`, `detail.fieldErrors`).

Accessibility: the summary is announced once via the status region's `aria-live="polite"`; per-field
messages are linked with `aria-describedby` so they're read **on focus**, not mass-announced (so they
are deliberately **not** `role="alert"`); and focus lands on the summary list when present, otherwise
the first invalid field.

## Styling

Styling is **entirely yours** — the markup is too, so ordinary scoped `<style>` rules reach it with no
`:global` and no package class names to track. The enhancement exposes two state hooks to key off:

- `data-astro-form-state` on the status element — `pending` / `success` / `error` while submitting.
- `aria-invalid="true"` on each faulty field (plus your own `[data-astro-form-field-error-for]` /
  `[data-astro-form-field-error-summary]` elements, which the client fills).

```css
[data-astro-form-status][data-astro-form-state='error'] {
  color: var(--color-red);
}

[data-astro-form] input[aria-invalid='true'] {
  border-color: var(--color-red);
}
```

## Secrets

The toolkit reads no environment variables itself — you pass secrets into the inspectors and dispatchers you
construct (see [The route](#the-route)), so where they load from is the site's choice. Keep them in
your host's secret store — a `.env` file locally and your platform's secrets in production (on
Cloudflare, Wrangler's `.dev.vars` and `wrangler secret`) — and wire them in:

- Postmark: `token` (transport), `from`/`to` (email dispatcher)
- Turnstile: `secretKey` (inspector)
- Discord (optional): a `webhookUrl` (dispatcher)

`PUBLIC_TURNSTILE_SITE_KEY` stays a build-time public var (each host's `PUBLIC_`/build env) for the widget.

## À la carte and bespoke flows

File uploads, rate limiting, and body-size caps are all first-class (see
[File uploads](#file-uploads) and [Guards](#guards)) — a form that needs them stays on the factory.
Genuinely bespoke flows can still import any piece on its own (`TurnstileInspector`, `FileUploads`,
`EmailDispatcher`, `createFileRoute`, `getField`, the response helpers) rather than the factory.

`RateLimitGuard` accepts any `RateLimiter` backing store — see [Guards](#guards) for the bundled
`InMemoryRateLimiter` and the shared-store options (Cloudflare binding, Redis, Upstash, Durable Object)
for production.

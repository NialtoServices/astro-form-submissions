# Changelog

Every release of `@nialto-services/astro-form-submissions`, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0, any release can ask something of a site.

Each version's **Upgrading** section lists what a site must do to move to it. To jump several versions, work through
every Upgrading section from the oldest version skipped to the newest.

## [Unreleased]

The route now caps the body it reads, upload receipts and grants work once, every refusal is reported with a
reason code, and a form posted without JavaScript gets a page a person can read.

### Upgrading

1. **Presigned uploads: add `Content-Disposition` to the bucket's CORS rule before deploying.** Presigned
   uploads now sign a `Content-Disposition: attachment` header, which the browser sends with every upload, so
   a rule without it fails every presigned upload at preflight. Worker uploads are unaffected.

   ```json
   "AllowedHeaders": ["Content-Disposition", "Content-Type", "If-None-Match", "x-amz-meta-filename-uri"]
   ```

2. **A custom `FileStorage` used with `UploadedFiles` must implement `claim(key)`**, which records once and
   atomically that a submission has taken an object, returning `true` for the first claim only; `UploadedFiles`
   throws at construction without it. Its `putStream` should also refuse a key that holds an object or has been
   claimed by throwing `ObjectExistsError`. `R2Storage` does both.
3. **Check the body limits suit the form.** The route reads at most `maxBodyBytes` (default 1 MiB, plus each
   `FileUploads` enricher's `maxTotalBytes`) and, for a body that isn't multipart, `maxTextBodyBytes` (default
   64 KiB), refusing anything larger with `requestTooLarge` (413). Raise `maxBodyBytes` if a custom enricher
   reads files from the multipart body.
4. **`onError` now also receives every refused, dropped or quarantined submission** as a
   `SubmissionVerdictError`. A hook that forwards everything to an error tracker should skip these or route
   them elsewhere.
5. **Take `cf-turnstile-response` out of the schema.** An inspector's own fields are now removed before
   validation, so a schema that requires the Turnstile token refuses every submission.
6. **Set Astro's `site`** for the built-in emails to show the site's host and link its home page; they no
   longer fall back to the request's URL.
7. **Some options are now checked when the route is built**, and throw if invalid: `DiscordDispatcher`'s
   `webhookURL` must be an absolute `https` URL, `RateLimitGuard` needs a `limiter` with a `limit` method,
   `PostmarkTransport`'s `timeoutSeconds` can be at most 2,147,483, `InMemoryRateLimiter`'s `maxKeys` must be a
   finite positive number, and `createFormRoute`'s `successURL` must be an `http(s)` URL or a path.
8. **A copy table typed `Record<ToolkitErrorKey, string>` needs three new entries**: `requestTooLarge`,
   `plainSubmitted` and `plainRetry` (`DEFAULT_ERROR_COPY` has the default wording).
9. **An `onError` hook that checks for `PostmarkDeliveryError` or `DiscordDeliveryError`** no longer sees a 502
   or 504: those arrive as `DestinationUnreachableError`, with the provider's error as its `cause`.
10. **`DOCUMENT_TYPES` and `ALL_TYPES` now accept Word, OpenDocument text, RTF and plain text, and `ALL_TYPES`
    also phone video.** A site relying on either default that wants the previous list sets
    `accept: [...IMAGE_TYPES, FILE_TYPES.pdf]`.

### Added

- A form posted without JavaScript gets a 303 to the new `successURL` option, or a plain-text confirmation,
  and refusals in plain text with a line asking the person to go back. The script and other `fetch` callers
  still get JSON. The two lines are copy under the new keys `plainSubmitted` and `plainRetry`.
- `createFormRoute` options `maxBodyBytes` and `maxTextBodyBytes`, and `maxTextBodyBytes` on
  `createUploadRoute`.
- Reason codes and machine-readable details on every built-in refusal, printed by the default reporter and
  listed in the README's **Logs** section. A custom guard, inspector or enricher can attach its own `code` and
  `details`.
- `OperationalError`, with a code, for the toolkit's own operational failures, such as
  `storage.delete-failed` with the keys that couldn't be deleted.
- `Inspector.controlFields`, naming fields the route removes before validation.
- `FileLink.key`, the stored object's key, for erasure requests.
- `DiscordDispatcher`'s `escapeMarkdown` option, and `escapeDiscordMarkdown` for custom embeds.
- Exports `SubmissionVerdictError`, `ReportedVerdictAction`, `OperationalError`, `OperationalErrorOptions`,
  `ObjectExistsError`, `escapeDiscordMarkdown`, `DEFAULT_MAX_BODY_BYTES`, `DEFAULT_MAX_TEXT_BODY_BYTES`,
  `VerdictReason`, `VerdictDetails` and `VerdictDetail`.
- This changelog, which now ships with the package.
- `FileMatcher.inspect` and `FileStorage.readRange`, so a type check can read beyond the file's first bytes;
  `R2Storage` implements it. Also exports `ByteRangeReader`, `MAX_INSPECTED_BYTES` and `MAX_INSPECTED_READS`.
- A direct upload the storage fails to read while checking its type is refused with `uploadMissing` and
  reported as an `OperationalError` (`uploaded-files.read-failed`) naming the object's key.
- `FILE_TYPES`, a frozen object naming every built-in matcher (`avif`, `gif`, `heic`, `jpeg`, `png`, `webp`, `pdf`,
  `docx`, `doc`, `odt`, `rtf`, `text`, `quicktime`, `mp4`, `threeGPP`, `webm`, `matroska`), and the groups
  `VIDEO_TYPES`, `MEDIA_TYPES`, `WORD_TYPES` and `TEXT_TYPES` beside `IMAGE_TYPES`, `DOCUMENT_TYPES` and `ALL_TYPES`.
  The README's **File types** section lists what each type guarantees and when it is refused.
- File types: Word (`.docx` and `.doc`), OpenDocument text, RTF, plain text (which includes Markdown), and the
  video containers QuickTime, MP4, 3GP, WebM and Matroska. Each is recognised from the file's bytes.
- Every built-in matcher has a `label`, such as `PDF`, `JPEG` and `Word`, for hint text.

### Changed

- A request waits at most 5 seconds in all on its `onError` calls, counting only time a report is pending, then
  answers anyway; every report still reaches the hook. `defineLazyRoute`'s `onError` is bounded the same way.
- Refused Worker uploads are reported with `upload-put.*` codes.
- A matcher whose `test` throws is treated as no match, and the next matcher is tried.
- A 502 or 504 from Postmark or Discord is a `DestinationUnreachableError`, so uploaded files are kept as for
  any delivery whose outcome is unknown.
- Discord values are escaped as markdown, leaving bare URLs linkable, and webhooks mention no one.
- Stored filenames gain the extension of their checked type when they lack it, and are capped at 200
  characters including it.
- A `link` builder that returns anything but an absolute `http(s)` URL fails the upload
  (`file-link.invalid-url`) rather than sending a broken link.
- `InMemoryRateLimiter` stores keys longer than 128 characters as a SHA-256 digest.
- Every toolkit error message ends with a full stop.
- The form script returns focus to the submit button after a submission that doesn't swap the form, lets the
  success panel take focus without a `tabindex`, makes summary entries for fields without an `id` keyboard
  links, announces upload progress in 25% steps, and warns when a form lacks a status element.
- Releases are published from CI through npm trusted publishing, with provenance.

### Fixed

- A failed request, timeout or upload announces the generic error copy when no `networkError` copy is set,
  where it announced nothing.
- The form script stops waiting for a Turnstile widget that never rendered, after a 2-second grace period.
- A submit timeout too long for a browser timer falls back to the default instead of firing at once.
- A dispatcher whose properties throw when read no longer rejects its whole dispatch group.
- A resolver that quotes the sender's name, as in `"Lovelace, Ada" <ada@example.com>`, is delivered.
- Downloads with an empty stored name are named `download` in both forms of the `Content-Disposition` header.
- The published type declarations resolve the package's internal imports to files it ships. Earlier versions
  pointed TypeScript at source files that aren't published, leaving those types to its fallback resolution.

### Security

- The request body is capped before it's parsed, and a body whose `Content-Type` joins several types with
  commas is held to the text limit.
- Each upload receipt works for one submission only (`uploaded-files.receipt-used`), and a refused submission
  deletes only the objects it claimed.
- A Worker upload grant is write-once, and no upload can rewrite a key a submission has claimed.
- Stored filenames and download names lose every control character and bidirectional text control, and
  trailing dots and spaces; the plain-ASCII download name keeps no `%`.
- A `to` or `replyTo` resolver that returns several addresses (a `,`, `;` or second `@` outside a quoted
  display name) or any control character is refused with `EmailRecipientError`, which now names the field.
  Control characters in a rendered subject or a resolved `from` become spaces.
- Signed tokens verify only in the exact spelling they were issued in.
- `TurnstileInspector` fails closed on an unexpected error, and refuses tokens longer than 2,048 characters
  without calling Siteverify.
- The built-in emails take the site's host only from Astro's `site`, never from the request.

## [0.3.1] - 2026-10-02

### Fixed

- Direct uploads leave out disabled file inputs, so files chosen in a field the page has since hidden and
  disabled are no longer uploaded and attached.

## [0.3.0] - 2026-10-02

Files can now upload straight to storage instead of passing through the form request.

### Upgrading

1. **Give `DiscordDispatcher` a non-empty webhook**: constructing it without one now throws at startup instead
   of failing each delivery. Rename `webhookUrl` to `webhookURL` while there; the old spelling still works but
   is deprecated.
2. **Check that numeric options are finite and positive**: `FileUploads`' `maxFiles` (a whole number),
   `maxFileBytes` and `maxTotalBytes`, and `PostmarkTransport`'s `timeoutSeconds`. `NaN` (from
   `Number(env.X)` with the variable unset, say), zero or a negative value now throws at construction instead
   of switching the limit off or failing every send.
3. **Make every `EmailDispatcher` `to` function return a single address.** A result containing `,` or `;` now
   throws `EmailRecipientError`. A fixed `to` string can still list several of the site's own inboxes.
4. **Give each enricher its own `attachTo` key.** Two enrichers providing the same key in one submission now
   refuse it with `invalidForm` and roll back. `FileUploads` and `UploadedFiles` may share a key, since a
   genuine request feeds only one of them.
5. **Update `onError` reporters or log alerts that look at delivery failures.** A Postmark or Discord delivery
   that can't connect or times out is now a `DestinationUnreachableError` naming the destination, with the
   original error as its `cause`. The default log line adds `destination=`, `code=` and `cause=`.
6. **Update anything that lists every value of these types or builds them by hand**: `ToolkitErrorKey` (and so
   `DEFAULT_ERROR_COPY`) gains `uploadMissing`, `FormErrorStage` gains `upload`, and `GuardContext` gains a
   required `route` (`'form' | 'upload'`). Copy tables typed `Record<ToolkitErrorKey, string>` and
   `GuardContext` fixtures in a site's own guard tests are the usual places.

### Added

- Direct uploads, so large files don't pass through the form request:
  - `createUploadRoute` admits a request exactly as the form route does, checks the declared files against the
    limits, and returns where to upload each one with a signed receipt;
  - the `UploadedFiles` enricher verifies each receipt, checks the stored object's size, sniffs its type and
    links it as `FileUploads` does, refusing with the new `uploadMissing` key when one doesn't check out;
  - `R2PresignedUploadTarget` presigns R2 uploads, each bound to the admitted type, filename and size and
    writable once;
  - `WorkerUploadTarget` with `createUploadPutRoute` uploads through the site instead, for local development;
  - grants and receipts last an hour by default (`receiptTTLSeconds`, `expiresInSeconds`, `ttlSeconds`);
  - the form script opts in through `data-astro-form-upload-action`, `data-astro-form-upload`,
    `data-astro-form-upload-field`, `data-astro-form-upload-receipt-field` and
    `data-astro-form-message-uploading`, emits `astro-form:upload-progress`, skips empty files, and aborts an
    upload that stalls for longer than the submit timeout.
- A `clientAddress` option (`ClientAddressResolver`) on `createFormRoute` and `createUploadRoute`, setting the
  client address the rate-limit key, Turnstile's `remoteip` and every stage use.
- `rateLimitKeyForAddress`, so a custom rate-limit `key` can group addresses as the default does.
- Optional `putStream` and `peek` methods on `FileStorage`, which `R2Storage` implements.
- `PostmarkDeliveryError` exposes Postmark's refusal code as `code`, and `jsonOk` accepts extra fields to
  return alongside `ok`.
- Exports `ErrorReporter`, `defaultErrorReporter`, `DiscordDeliveryError`, `DestinationUnreachableError`,
  `EmailRecipientError`, `sniffBytes`, `AdmittingRoute`, `DiscordWebhook`, `DiscordDispatcherSettings`,
  `PeekedObject` and `StreamPutOptions`.

### Changed

- The default rate-limit key is scoped to the route admitting the request (`form:192.0.2.1`, say), so a
  direct-upload submission isn't counted twice against a shared limiter. Existing counts start afresh.
- An email or Discord delivery that times out or can't connect no longer deletes uploaded files, since it may
  have gone through; a definite refusal still rolls them back.
- The form script waits up to 30 seconds for every Turnstile widget to hold a token before submitting, instead
  of posting an empty token while a widget loads, and warns in the console when a Turnstile reset or the
  success display fails.
- `DiscordDispatcher`'s `webhookUrl` is deprecated in favour of `webhookURL`.

### Fixed

- The server bundle no longer loads `astro` at runtime through empty side-effect imports.
- An email attachment with no known size no longer shows the submission's own `size` field beside its link.
- File sizes just under a unit boundary read as the next unit (`1 MB`, not `1024 KB`).
- A filename made only of line breaks or quotes is stored as `upload` instead of an empty name.
- A schema that throws, and other unexpected failures after the form is read, answer in the sender's language
  when a copy resolver localises by a form field.
- A Postmark refusal whose body stalls no longer hangs the delivery, and a Siteverify response that stalls
  after its headers is reported as a timeout.
- The form script posts to the submitter's `formaction`, survives a control named `action`, links error
  messages to fields that already have an `aria-describedby` hint, flags and clears a radio or checkbox group
  together, and ends an unexpected exception in the generic error instead of leaving the form pending.

### Security

- Form bodies are parsed in a single pass. Parsing time grew with the square of the field count, so one large
  unauthenticated request could stall the route.
- The default rate-limit key groups IPv6 clients by their /64 network, and IPv4-mapped addresses as IPv4, so
  one host can't take a fresh bucket for every request.
- The `clientAddress` resolver lets a site whose adapter takes `context.clientAddress` from a client-settable
  header (Node behind a proxy, for example) stop clients changing their address to pass the rate limit.
- Downloads are served with `Content-Security-Policy: sandbox; default-src 'none'`, so a browser that renders
  a file anyway runs no script in the site's origin.
- `EmailDispatcher` refuses a `to` function that resolves to several addresses, so a submission can't spread
  one acknowledgement across many recipients. The acknowledgement guidance now says to protect the route with
  Turnstile and a rate limit and to echo back only fields the schema constrains: no free text, no name in
  `greeting`, no `attachments`. A site that followed the earlier recipe should review its acknowledgement.
- A request that feeds two enrichers the same resource key is refused, so it can't double the file limits or
  strand stored files.

## [0.2.1] - 2026-09-29

### Upgrading

1. **Match Postmark refusals by `PostmarkDeliveryError`** in an `onError` reporter or elsewhere, rather than by
   the `postmark` client's own error classes. It carries the HTTP `status`, Postmark's `errorCode` and its
   message. A send that reaches `timeoutSeconds` rejects with the runtime's abort error.
2. **Add `postmark` as a direct dependency** if the site imports it itself; this package no longer installs it.

### Added

- `PostmarkDeliveryError`, thrown by `PostmarkTransport` when Postmark refuses a message, so a problem with an
  address can be told apart from a problem with the account.

### Changed

- `PostmarkTransport` calls Postmark's API with the runtime's own `fetch`; the `postmark` dependency and its
  HTTP client are gone.
- The toolkit no longer needs Cloudflare Workers' `nodejs_compat` flag; a site can drop it if nothing else
  needs it.
- The default `onError` summary for a refused Postmark send reads `PostmarkDeliveryError status=<n>`.

### Fixed

- Every email sent through `PostmarkTransport` on Cloudflare Workers failed with "Unsupported cache mode:
  default" once a newer release of the old HTTP client was installed.

## [0.2.0] - 2026-09-28

### Upgrading

1. **Add a case for the new `'build'` stage** wherever `FormErrorStage` is handled exhaustively (a `switch`
   with a `never` check, or a `Record<FormErrorStage, …>`).
2. **Remove anything from `dispatchers` that isn't a dispatcher**, such as a conditional `undefined` or `false`
   entry. `createFormRoute` now throws a `TypeError` when the route is built, where the entry used to fail as a
   delivery error on each submission.

### Added

- Dispatch groups: `dispatchers` also accepts a list of groups (`DispatchGroup`). Dispatchers within a group
  run concurrently, and each group starts once the previous one has settled; a failed `required` delivery
  stops later groups and returns 502, so an acknowledgement can wait until the owner's notification has
  landed. A flat list still runs as one group, as before.
- `requireEnv(env, keys)`, returning the named values typed as present, or throwing one `MissingEnvError` that
  names every absent key and never a value.
- `defineLazyRoute(build, { onError })` (`LazyRouteOptions`), reporting a failed lazy build with
  `stage: 'build'` through the same reporter shape as the route's `onError`.

### Changed

- `dispatchers` and dispatch groups accept readonly arrays, so `as const` lists type-check.
- `createFormRoute` checks `dispatchers` when the route is built and throws a `TypeError` for a mix of
  dispatchers and groups, a group within a group, or an entry that isn't a dispatcher.

## [0.1.1] - 2026-07-17

### Upgrading

1. **Correct or remove any `fields` entry (or `FieldSpec` `key`) that names a key the schema doesn't output**,
   in `submissionNotificationTemplates`, `submissionAcknowledgementTemplates`, `DiscordDispatcher` and
   `resolveField`/`resolveFields`. Such keys now fail to type-check.
2. **Fix any dispatcher callback that reads a property the schema doesn't output**, such as
   `replyTo: (submission) => submission.x`: `Submission<S>` no longer allows arbitrary keys.

### Fixed

- `fields` lists and other field-key positions reject typos and keys outside the schema's output, instead of
  accepting any string.

## [0.1.0] - 2026-07-16

The first release.

### Added

- `createFormRoute`, an Astro `POST` handler factory running a fixed pipeline: guards (before the body is
  read), Standard Schema validation, inspectors, enrichers, then dispatchers, answering in JSON with
  per-field validation errors.
- Validation through any Standard Schema library, such as Zod 4, or a per-request schema factory.
- Keyed `FormError`s with per-site copy through `errors`, as a static map or a resolver that localises by
  reading the request; `ERRORS` and `DEFAULT_ERROR_COPY` are exported.
- An `onError` reporter for handled failures, whose default logs only a PII-safe summary.
- Guards: `RateLimitGuard`, taking any `RateLimiter`, and a bundled `InMemoryRateLimiter`. Guards fail open
  unless set with `failClosed`.
- Inspectors: `HoneypotInspector` and `TurnstileInspector`, returning accept, quarantine, drop or reject; a
  quarantined submission reaches only dispatchers with `acceptsQuarantined`.
- File uploads through the `FileUploads` enricher: files checked by magic bytes against `IMAGE_TYPES`,
  `DOCUMENT_TYPES` or `ALL_TYPES` with count and size limits, stored through `R2Storage` or any `FileStorage`,
  linked with signed, expiring links (`signedLink`), and deleted again if delivery fails.
- `createFileRoute`, serving signed downloads: 404 for a bad or expired link, 410 once the file is gone, and
  an attachment disposition with `nosniff`.
- `EmailDispatcher` with `PostmarkTransport`, replaceable through `EmailTransport`; ready-made
  `submissionNotificationTemplates` and `submissionAcknowledgementTemplates` with translatable `copy`; and
  site-owned Mustache templates through `mustacheTemplates`.
- `DiscordDispatcher` for webhook delivery.
- Per-dispatcher `required`, `deliverWhen` and `acceptsQuarantined`.
- `defineLazyRoute`, building a route on its first request for platforms that provide secrets only at request
  time, and retrying after a failed build.
- `initializeForms` (from `/form`), progressively enhancing a site's own markup through `data-astro-form-*`
  attributes: `fetch` submission with a timeout and a status live region, inline field errors and an error
  summary, Turnstile reset, an optional swap to a success message, and `astro-form:success` and
  `astro-form:error` events.
- Helpers for bespoke flows: `jsonOk`, `jsonError`, `jsonFormError`, `jsonValidationError`, `getField`,
  `formDataToObject` and `mapIssues`.

[Unreleased]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NialtoServices/astro-form-submissions/tree/v0.1.0

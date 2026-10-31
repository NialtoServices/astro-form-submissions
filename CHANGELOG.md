# Changelog

Every release of `@nialto-services/astro-form-submissions`, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0, any release can ask something of a site.

Each version's **Upgrading** section lists what a site must do to move to it. To jump several versions, work through
every Upgrading section from the oldest version skipped to the newest.

## [Unreleased]

### Upgrading

1. **Check any dispatcher of your own that has a `name` property.** The route now reads `name` as the dispatcher's
   name in delivery reports, and refuses to build when it isn't 1 to 64 letters, digits, `_`, `.`, `:` or `-`, or
   when two dispatchers share one. Rename the property if it means something else.

### Added

- An optional `name` on every dispatcher, including `EmailDispatcher` and `DiscordDispatcher`, such as
  `owner-notification`, `acknowledgement` or `team-chat`. A failed delivery is reported under it.
- A delivery failure's report names the dispatcher: `onError` receives `dispatcher: { name, required }` beside
  `stage`, on the failure and on any `delivery.links-kept` report that follows it. The context is exported as
  `ErrorReportContext`.

### Changed

- The default reporter's delivery line starts with `dispatcher=` (when the dispatcher has a name) and `required=`,
  so a lost owner notification reads differently from a missed acknowledgement:
  `delivery error: dispatcher=acknowledgement required=false PostmarkDeliveryError code=10 status=401`. A log alert
  that matches the old line exactly needs updating.

## [0.4.0] - 2026-10-23

Emails can carry uploaded files as attachments, files are recognised as Word, OpenDocument text, RTF, plain text and
phone video as well as images and PDF, and a file field's limits are declared once for the route, the input and its
hint. The form script lists, checks and manages chosen files, takes dropped files, shows direct-upload progress, binds
forms added after it starts, follows fields a site disables, and can push an analytics event and mark whether a
Turnstile widget is showing. The route caps the body it reads, upload receipts and grants work once, every refusal is
reported with a reason code, and a form posted without JavaScript gets a page a person can read.

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
   `FileUploads` and `FileAttachments` enricher's `maxTotalBytes`) and, for a body that isn't multipart,
   `maxTextBodyBytes` (default 64 KiB), refusing anything larger with `requestTooLarge` (413). Raise `maxBodyBytes`
   if a custom enricher reads files from the multipart body.
4. **Keep verdicts out of an error tracker.** `onError` now also receives every refused, dropped or quarantined
   submission as a `SubmissionVerdictError`, so a hook that forwards everything to an error tracker should skip
   these or route them elsewhere.
5. **Take `cf-turnstile-response` out of the schema.** An inspector's own fields are now removed before
   validation, so a schema that requires the Turnstile token refuses every submission.
6. **Set Astro's `site`** for the built-in emails to show the site's host and link its home page; they no
   longer fall back to the request's URL.
7. **Check the options now validated when the route is built**, since an invalid one throws: `DiscordDispatcher`'s
   `webhookURL` must be an absolute `https` URL, `RateLimitGuard` needs a `limiter` with a `limit` method,
   `PostmarkTransport`'s `timeoutSeconds` can be at most 2,147,483, `InMemoryRateLimiter`'s `maxKeys` must be a
   finite positive number, and `createFormRoute`'s `successURL` must be an `http(s)` URL or a path.
8. **Add five entries to a copy table typed `Record<ToolkitErrorKey, string>`**: `requestTooLarge`,
   `plainSubmitted`, `plainRetry`, `filesTooLarge` and `fileRequired` (`DEFAULT_ERROR_COPY` has the default wording).
9. **Check for `DestinationUnreachableError` too in an `onError` hook that looks for `PostmarkDeliveryError` or
   `DiscordDeliveryError`.** A 502 or 504 from either provider now arrives as a `DestinationUnreachableError`, with
   the provider's error as its `cause`.
10. **`DOCUMENT_TYPES` and `ALL_TYPES` now accept Word, OpenDocument text, RTF and plain text, and `ALL_TYPES`
    also phone video.** To keep the previous list, a site relying on `ALL_TYPES`, or on the default `accept`, sets
    `accept: [...IMAGE_TYPES, FILE_TYPES.pdf]`, and one relying on `DOCUMENT_TYPES` sets `accept: [FILE_TYPES.pdf]`.
11. **A `fileTooLarge` override now applies only to a single file.** The files together over `maxTotalBytes` are
    refused with the new `filesTooLarge` key, so copy that reads as a per-file limit no longer shows for a total.
    Add a `filesTooLarge` entry beside it.
12. **Check what `to` and `replyTo` functions return.** Each must return `local@domain` or `Name <local@domain>`;
    anything else now throws `EmailRecipientError`. The name must be plain text without `" ( ) , : ; < > @ [ \ ]`, or
    quoted with no `"` or `\` inside, and either way hold no control character, no whitespace but spaces, no
    compatibility character (such as a fullwidth comma) and no `=?`. Never put a name the sender typed into `to` or
    `replyTo`: an ideographic space, common in Japanese names, and half-width katakana are refused, so the email fails
    for those people every time, retries included. Return the bare address instead
    (`to: (submission) => submission.email`).
13. **Mark only one file input per form `data-astro-form-upload`.** A form has one upload action, one descriptor field
    and one receipt field, so the script now uploads directly from the first marked input only; the others post as
    ordinary file inputs, with a console warning. A form that marked several needs its extra fields on `FileUploads`
    instead.
14. **Rename `webhookUrl` to `webhookURL` on every `DiscordDispatcher`.** The old spelling is removed, no longer
    type-checks and is no longer read, so a dispatcher given only `webhookUrl` throws at construction, as one
    without a webhook does.

Once on this release, a site can also drop the logging wrappers and body-size guards it wrote for earlier ones,
since the route now reports every refusal and caps the body itself. Nothing breaks if they stay; "Migrating a site
from its own wrappers" in the README says what each one was for.

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
- `TurnstileInspector`'s `verifyHostname` accepts a comma-separated string, such as an environment variable's value:
  entries are trimmed and blanks dropped, and a string with no entries (blank or unset) means the check is off. A
  literal `[]` still rejects everything.
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
- `required: true` on `FileUploads` and `UploadedFiles` refuses an empty file field with the new `fileRequired`
  key (`file-uploads.required` and `uploaded-files.required`).
- Copy placeholders: an error's copy, whether the default or a site's override (a map or a resolver), can use
  `{name}` tokens. File refusals offer `{maxFiles}`, `{maxFileSize}`, `{maxTotalSize}` and `{types}`. A token with
  no value is left as written. `formError` takes `field` and `placeholders` options, and `FormError` carries them.
- `UploadedFiles` and `createUploadRoute` take an `input` option, the file input's name, which their refusals are
  reported against. It defaults to `file`.
- The new error keys `filesTooLarge` and `fileRequired` join `ToolkitErrorKey` and `DEFAULT_ERROR_COPY`.
- `uploadRules`, which validates and freezes a file field's limits and accepted types (`maxFiles`, `maxFileBytes`,
  `maxTotalBytes`, `accept`, `required`) so one shared definition spreads into `FileUploads`, `UploadedFiles` and
  `createUploadRoute`; `uploadInputAttributes`, which gives the file input its `accept`, `multiple`, `required`,
  limit attributes and `data-astro-form-accepted-types` (the types in the server's words) from the same rules;
  and `describeUploadRules`, which writes the hint ("Up to 5 files, 10 MB each, 50 MB in total. Accepted: JPEG,
  PNG or PDF.") or fills a template of your own using `{maxFiles}`, `{maxFileSize}`, `{maxTotalSize}` and
  `{types}`. Also exports the `UploadRules` type. Rules that omit `maxFileBytes` get `maxTotalBytes` as their
  per-file limit, so no enricher default applies behind them. The rules spread into `FileAttachments` too.
- `FileAttachments`, an enricher for files that go with the submission instead of into storage. It checks the form's
  files as `FileUploads` does, holds them in memory as `AttachedFile`s (`name`, `contentType`, `size` and `bytes()`)
  under `context.resources[attachTo]` (an empty list when the field is empty), and has nothing to roll back. Its total defaults to 5 MB
  (`DEFAULT_ATTACHMENT_TOTAL_BYTES`), `maxFileBytes` applies only when given, `required: true` refuses an empty field
  with `fileRequired`, and its reason codes are `file-attachments.*`. The route's default `maxBodyBytes` also adds
  each `FileAttachments` enricher's total. Also exports `AttachedFile` and `FileAttachmentsOptions`.
- The `accept` option of `FileUploads`, `UploadedFiles` and `createUploadRoute`, and the `sniffBytes` and `sniffType`
  parameters, take a `readonly FileMatcher[]`.
- `EmailDispatcher`'s `attach` option, naming the `context.resources` key whose files the email carries as
  attachments, such as a `FileAttachments` enricher's `attachTo`. They reach the transport on the new
  `EmailMessage.attachments` as `EmailAttachment`s (`filename`, `contentType`, `content`); a message without any has
  no `attachments` property. The type check refuses a key no enricher provides, or one holding `FileUploads` links, for a dispatcher declared
  separately from the route; otherwise a missing key fails the delivery with `email.attach-missing`.
  Attaching leaves `exposesResources` alone. Also exports `EmailAttachment`.
- `PostmarkTransport` sends a message's attachments (`Name`, base64 `Content`, `ContentType`) and leaves `Attachments`
  out of a message without any. Postmark accepts at most 10 MB per message after base64, which makes a file about a
  third larger, so the transport measures the request and refuses an oversized message itself, without calling
  Postmark: it throws an `OperationalError` with the code `postmark.message-too-large` and the `bytes` and `limit`
  in its details, a definite failure that answers a required email's submission with `send` (502). `FileAttachments`'
  default total of 5 MB leaves room. Also exports `POSTMARK_MAX_MESSAGE_BYTES`.
- The form script manages a file field that has a `data-astro-form-file-list-for` list: each chosen file is listed
  from the list's `<template>`, filling every `data-astro-form-file-name` slot and its `-file-size` and
  `-file-problem` slots, and wiring its `-file-remove` control, which is described by the file's name and problem.
  Picks add up (the same file is listed once, and a field without `multiple` replaces its file), and the input
  always holds the listed files. Each file is checked in the browser against the input's `accept`,
  `data-astro-form-max-files`, `-max-file-bytes` and `-max-total-bytes`, in the server's wording: the same default
  copy, with `{types}` from the new `data-astro-form-accepted-types`. The input's
  `data-astro-form-message-too-many-files`, `-file-too-large`, `-files-too-large`, `-file-type` and `-file-required`
  replace it. While a file has a problem, or a required field is empty, the form sends nothing and answers as it
  does a server's refusal: the message in the status, the field's error, `astro-form:error`, and focus on the
  summary or the file's remove control. A flagged item carries `data-astro-form-file-state="invalid"`, and the list
  carries `data-astro-form-invalid` while the field is invalid. The files are kept after a refused submission and
  cleared on success, on reset and when the field is disabled. A file input with no list, drop zone or progress part
  is left as the browser provides it. See "File fields" in the README.
- A file field takes files dropped on the input itself, or on any element in the form marked
  `data-astro-form-file-drop-for="<name>"`, as if they were picked: they join the selection, are listed once and are
  checked like any other, and a file of the wrong type is listed and flagged. A drop zone makes a field managed
  without a list, which then shows no items. The target carries `data-astro-form-file-drop="active"` while a file is
  dragged over it, for styling. A field without `multiple` keeps the first file of a drop and says "Only one file can
  be added." in the form's status, in the copy of the input's new `data-astro-form-message-only-one-file`; it is not
  marked invalid, and the notice goes once the next pick or drop is accepted. A disabled field ignores drops and shows
  no hover state. While any drop target is on the page, the script also stops the browser opening a file dropped
  anywhere else, which would replace the page and lose what was typed; text drags, and drops on an enabled file input
  with no list, drop zone or progress part, are left alone. A site's own drop zone outside these parts has its file
  drops cancelled: marking the zone `data-astro-form-file-drop-for` makes it a target. See "Dropping files" in the
  README.
- The form script shows upload progress for a direct upload. A `[data-astro-form-file-progress]` slot in a listed item,
  and any `[data-astro-form-upload-progress-for="<name>"]` element in the form (which alone makes the field
  managed), follow the upload: a `<progress>` has its `value` and `max` set in bytes, and any other element has
  `--astro-form-progress` set from `0` to `1`. The field's part counts the bytes of every file, and each part, and
  the item, carries `data-astro-form-file-state` of `uploading` or `done`; a failed or refused upload returns them
  to `0` and removes the state. An ordinary file field's parts are never touched. See "Upload progress" in the README.
- Mark an element `data-astro-form-requires-script`, and render it `hidden` and `disabled`, for the script to reveal
  and enable it when it binds the form, so a direct-upload field only appears when it can work. Without JavaScript it
  stays hidden and disabled, so a `required` input inside it can't block the post, and the rest of the form posts;
  make such a field required with `UploadedFiles`' `required` instead. A `<noscript>` note beside it is the site's
  own. See "Fields that need the script" in the README.
- `data-astro-form-analytics="<form name>"` on a form makes the script push `{ event: 'form_submission', form_name }` to
  `window.dataLayer` each time the form is sent successfully, creating the array if the page has none and never
  replacing one. A submission the server quietly drops as spam is answered as a success, so it is counted too; a
  refusal and a form posted without JavaScript are not. An empty value warns once and pushes nothing. Google Tag
  Manager needs a trigger for the event; see "Analytics" in the README.
- The form script keeps `data-astro-form-turnstile` on each `.cf-turnstile` container in a form: `visible` while the
  widget takes up room and `invisible` while it doesn't, as an interaction-only or execute widget does until it needs
  the visitor, and also before Cloudflare's script has rendered anything. A form without a container gets no
  attribute. Style a wrapper with it to collapse the space around an invisible widget; a `min-height` on the
  container itself reads as visible. See "Styling the Turnstile widget" in the README.

### Changed

- The form script follows a field a site disables, directly or through a disabled `<fieldset>`: the field's
  `aria-invalid` mark, error slot and summary entry are cleared at once, and a disabled field is never focused or
  listed when errors are shown. A field that is only `hidden` is unaffected. See "Fields that come and go" in the
  README.
- A form has one direct-upload field. When several file inputs in a form carry `data-astro-form-upload`, the script
  uses the first, leaves the others as ordinary file inputs and warns once in the console, naming both inputs.
- Forms added to the page after `initializeForms()` bind themselves. Calling it again is harmless, and a form
  moved within the page (into a drawer, say) keeps its state. A form missing its status element warns once, and
  binds once the element is added.
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
  links, and announces upload progress in 25% steps.
- Releases are published from CI through npm trusted publishing, with provenance.
- File refusals name the field: `{ error, fieldErrors: { <input>: … } }`, so the script marks the file input and
  reports it like a validation failure. `jsonFormError` answers with `fieldErrors` for any error that names a field.
- File refusals say what the limit is. The default copy is now `Please attach no more than {maxFiles} files.` (or
  `Please attach only one file.`), `Each file must be {maxFileSize} or smaller.`,
  `Your files add up to more than {maxTotalSize}.` and `That file type is not accepted. Please attach {types}.`, and
  the files together over `maxTotalBytes` are refused with `filesTooLarge` instead of `fileTooLarge`.
- A form posted without JavaScript is told a refusal that names a field once, not twice.

### Removed

- `DiscordDispatcher`'s `webhookUrl`, deprecated in 0.3.0 in favour of `webhookURL`.

### Fixed

- A failed request, timeout or upload announces the generic error copy when no `networkError` copy is set,
  where it announced nothing.
- The form script stops waiting for a Turnstile widget that never rendered, after a 2-second grace period.
- A submit timeout too long for a browser timer falls back to the default instead of firing at once.
- A dispatcher whose properties throw when read no longer rejects its whole dispatch group.
- A resolver that quotes a fixed display name, as in `"Lovelace, Ada" <ada@example.com>`, is delivered.
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
- A `to` or `replyTo` resolver must return one plain address, `local@domain` or `Name <local@domain>`, or it is refused
  with `EmailRecipientError`, which names the field and never the address. The address has one `@`, a dotted domain with
  no empty part, and no spaces or `" ( ) , : ; < > @ [ \ ]`; the name is plain text without those characters, or one
  quoted string with no `"` or `\` inside. Control characters (U+2028 and U+2029 included), whitespace other than a
  plain space, compatibility characters (any that NFKC normalisation changes, such as a fullwidth comma) and `=?` are
  refused anywhere. Every other shape (several addresses, comments, groups, domain literals, quoted local parts, encoded
  words) is refused, since some mail parser reads each as more than one recipient. Control characters in a rendered
  subject or a resolved `from`, U+2028 and U+2029 included, become spaces.
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

[Unreleased]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/NialtoServices/astro-form-submissions/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NialtoServices/astro-form-submissions/tree/v0.1.0

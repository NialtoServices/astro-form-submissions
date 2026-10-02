# Direct Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a form's files bypass the form route entirely: the browser uploads each file straight to
storage before submitting, and the submission carries signed receipts instead of file bytes. The form route
never buffers an upload, so upload size is no longer bounded by Worker memory or the edge's request-size
limit. Ships as 0.3.0.

**Architecture:** A new upload route admits a submission exactly as the form route does (guards, schema,
inspectors), checks the declared files against the limits, and returns, per file, an upload instruction
(URL, method, headers) and a signed receipt. Where the instruction points is a swappable `UploadTarget`:
`R2PresignedUploadTarget` presigns an S3-API PUT to R2 (production), and `WorkerUploadTarget` points back
at a site route that streams the body into the storage binding (local development under Miniflare, tests,
and a fallback). A new `UploadedFiles` enricher verifies each receipt on the final submission, confirms the
stored object's size and sniffed type through the binding, and builds the same signed download links as
`FileUploads`. The client script gains an opt-in flow that runs the three steps.

**Tech Stack:** TypeScript 6, Astro 7 (`APIRoute`), Web Crypto (HMAC-SHA256, SHA-256), Vitest 4 with
happy-dom for the client, pnpm 10.

**Spec:** No separate spec document. The design was agreed in conversation on 2026-10-02 and is recorded in
full in the **Design** section below, which is the spec for this plan.

## Design

Background: `FileUploads` reads files from the form's multipart body, so the route must buffer the whole
body (`request.formData()`) before any size or anti-bot check. A Worker's 128 MB memory limit belongs to the
isolate, which serves concurrent requests, so large uploads put every in-flight submission at risk, and the
edge refuses bodies over 100 MB on the Free and Pro plans regardless.

1. **Three requests per submission with files.**
   1. `POST <upload route>`: the form's text fields (multipart, no files) plus an `uploads` field holding a
      JSON array of `{ name, size, type }`, one per file. The route runs the configured guards, schema and
      inspectors, so field errors arrive before any upload, and the Turnstile token is spent here. It then
      checks the descriptors against `maxFiles`, `maxFileBytes` and `maxTotalBytes`. On success it answers
      `{ ok: true, uploads: [{ url, method, headers, receipt }] }`, one entry per descriptor, in order.
   2. `PUT <instruction url>` per file, with exactly the instruction's headers.
   3. `POST <form route>`: the text fields, a fresh Turnstile token, and one `upload` field per receipt. No
      file parts.
2. **Admission is shared.** The guard, body-parse, schema and inspector stages move out of `createFormRoute`
   into one internal function both routes call, so the two routes can't drift. A `drop` or `quarantine`
   verdict on the upload route answers `{ ok: true, uploads: [] }`: the sender sees nothing different, no
   storage is granted, and the final submission meets the same verdict on the form route.
3. **Object keys are server-generated** (`crypto.randomUUID()`), never client-chosen. Filenames are
   sanitised as `FileUploads` does (`\r`, `\n` and `"` removed).
4. **The stored content-type is constrained.** A descriptor's declared `type` is used for the upload only
   when it is one of the `accept` matchers' content-types; anything else uploads as
   `application/octet-stream`. On the final submission the object's leading bytes are sniffed against
   `accept`; the file is refused when nothing matches, or when its stored type is neither
   `application/octet-stream` nor the sniffed type.
5. **Tokens carry a purpose.** Download tokens, upload receipts and Worker upload tokens are all HS256
   tokens from one internal signer. Receipts carry `use: 'receipt'` and Worker upload tokens `use: 'put'`;
   download tokens carry no `use`, so links already in inboxes keep working. Each verifier accepts only its
   own purpose, so no token type can stand in for another.
6. **Receipt claims:** `objectKey`, `filename`, `size`, `contentType`, `exp`. Default lifetime one hour.
7. **`UploadTarget` is the seam.** `prepare(upload, context) → { url, method: 'PUT', headers }`.
   - `R2PresignedUploadTarget({ accountId, bucket, accessKeyId, secretAccessKey, prefix?, expiresInSeconds?, endpoint? })`
     presigns with AWS Signature Version 4 (query string, `UNSIGNED-PAYLOAD`, region `auto`, service `s3`),
     signing `host`, `content-type` and `x-amz-meta-filename-uri` (the filename percent-encoded, since header
     values must be ASCII). Default lifetime 15 minutes. Implemented on Web Crypto, no dependency. The
     bucket needs a CORS rule allowing `PUT` from the site's origins with those two headers.
   - `WorkerUploadTarget({ secret, basePath, ttlSeconds? })` returns a root-relative URL,
     `<basePath>/<token>/`, so the browser PUTs to whatever origin served the page (a dev server included).
     The token is a `use: 'put'` token carrying the receipt's claims. Its `.` separators become `~`, as
     download links do, to survive `trailingSlash: 'always'`.
   - `createUploadPutRoute({ storage, secret })` is the `PUT` handler for `WorkerUploadTarget`: it verifies
     the token, requires `Content-Length` to equal the token's `size` (411 without one, 413 when larger,
     400 when it differs), and streams `request.body` into storage. 404 for a bad or expired token.
8. **Storage gains two optional methods**, implemented by `R2Storage`:
   - `putStream(key, body, { contentType, filename, size })`, used by the Worker PUT route.
   - `peek(key, length)` → `{ size, contentType?, header: Uint8Array } | null`: the object's total size,
     stored type and first `length` bytes, through one ranged read.

   `R2Storage.get` reads the filename from `filename`, else decodes `filename-uri`, so objects uploaded by
   presigned URL download under their real name. `UploadedFiles` throws at construction when its storage
   lacks `peek`; `createUploadPutRoute` when its storage lacks `putStream`.

9. **`UploadedFiles` enricher** (`storage`, `secret`, `link`, `field` default `upload`, `attachTo`, limits,
   `accept`): verifies every receipt (any invalid or expired one refuses the submission with
   `uploadMissing`), de-duplicates object keys, re-checks the limits against the receipts' sizes, then peeks
   each object. A missing object or one whose size differs from its receipt refuses with `uploadMissing`;
   a failed sniff or type mismatch refuses with `fileType`. A refusal deletes every object the submission
   referenced. Success provides `FileLink[]` under `attachTo` with the same keep-on-exposing-delivery
   rollback as `FileUploads`.
10. **Client flow, opt-in.** A form with `data-astro-form-upload-action` (the upload route) and file inputs
    marked `data-astro-form-upload` runs the three steps when at least one file is chosen; otherwise it
    submits exactly as before. Marked file inputs never join a submission's form data. Uploads use
    `XMLHttpRequest` for progress; the status element shows
    `data-astro-form-message-uploading` with `{current}`, `{total}` and `{percent}` filled in, and the form
    emits `astro-form:upload-progress` (`{ current, total, loaded, size }`). Before the final POST the
    script resets the form's Turnstile widget and waits (up to 30 s) for a new token. Any failed step shows
    the server's error, or the network-error copy, and leaves the form for a retry, which starts again from
    step 1.
11. **New error key** `uploadMissing` (400, "One of your files didn't finish uploading. Please try again.").
    The upload route reuses `tooManyFiles`, `fileTooLarge` and `fileType`.
12. **Unchanged:** `FileUploads`, `createFileRoute`, the email templates and every existing option. A site
    can run both enrichers on one route (multipart for visitors without JavaScript, receipts otherwise),
    attaching to the same key; a request carries one kind or the other.

## Tasks

- [x] **1. Purpose-bound tokens.** Extract the HS256 signer from `files/signing.ts` into `#tokens.js`
      (`signClaims`, `verifyClaims` with expiry). Download tokens reject any `use`. Tests: a receipt or put
      token is refused by `verifyFileToken`, and vice versa.
- [x] **2. SigV4 presigning.** `uploads/sigv4.ts` (`presignURL`). Tests: AWS's published query-string
      example (GET `examplebucket/test.txt`), and a PUT with extra signed headers cross-checked against
      `aws4fetch` (dev dependency only).
- [x] **3. `UploadTarget`, `R2PresignedUploadTarget`.** Tests: URL host, path, query parameters, signed
      headers, returned headers, filename encoding, prefix.
- [x] **4. Storage `putStream` and `peek`; `R2Storage` filename decoding.** Tests through an in-memory
      bucket double that honours ranges.
- [x] **5. `WorkerUploadTarget` and `createUploadPutRoute`.** Tests: round trip into storage, bad token,
      expired token, wrong purpose, missing/oversized/mismatched length.
- [x] **6. Shared admission; `createUploadRoute`.** Move the admission stages; the existing route suite
      must pass unchanged. Tests for the upload route: response shape, schema errors, inspector reject,
      drop and quarantine, every limit, malformed `uploads` JSON, content-type selection.
- [x] **7. `UploadedFiles`.** Tests: happy path links, tampered/expired receipt, duplicate receipts, limits,
      missing object, size mismatch, sniff failure, type mismatch, deletion on refusal, rollback after a
      failed exposing delivery.
- [x] **8. Client flow.** happy-dom tests with a stubbed `fetch` and `XMLHttpRequest`: the three requests
      in order with the right bodies, progress copy and events, Turnstile refresh wait, failure at each step,
      no files falls back to the plain submit, marked inputs never sent.
- [x] **9. End-to-end integration test.** Upload route → Worker PUT route → form route → email link →
      download route returns the bytes, all through one in-memory bucket.
- [x] **10. README, exports, release 0.3.0.**

// Progressive-enhancement submit handling for a form the site owns entirely.
//
// The package ships no markup: you write your own `<form>` (and its honeypot input, status element,
// and any Turnstile container), mark it with the data attributes below, and call
// `initializeForms` to enhance it. The markup is yours, so ordinary scoped styles reach it; the
// only contract is the `data-astro-form-*` hooks, which are behavioural, not styling handles.
//
// Import it from a `<script>` on the page. One call also binds forms added to the page later, Astro View
// Transitions included; calling it again, as an `astro:page-load` listener does, is harmless:
//
// ```ts
// import { initializeForms } from '@nialto-services/astro-form-submissions/form'
// initializeForms()
// document.addEventListener('astro:page-load', initializeForms)
// ```
//
// ## The contract
//
// - `[data-astro-form]` — the `<form>` to enhance (required).
// - `[data-astro-form-status]` — a live-region element inside the form for status copy (required).
//   Carries the copy as `data-astro-form-message-{sending,success,generic-error,network-error}`, and
//   receives `data-astro-form-state` of `pending` / `success` / `error` while submitting.
// - `[data-astro-form-success]` — an optional element immediately after the form; when present, a
//   successful submission swaps the whole `<form>` out for it (and focuses it).
// - `[data-astro-form-field-error-for="<name>"]` — an optional co-located slot the script fills with
//   that field's message and links via `aria-describedby`.
// - `[data-astro-form-field-error-summary]` — an optional element the script fills with a list of
//   every field's message, each linking to its field.
// - `data-astro-form-submit-timeout` — optional per-form request timeout override, in milliseconds
//   (a non-positive or non-finite value is ignored in favour of the default). A direct upload uses it as
//   an idle deadline: it fails once that long passes with no progress.
// - `data-astro-form-analytics="<form name>"` — opts the form into analytics: each successful submission pushes
//   `{ event: 'form_submission', form_name }` to `window.dataLayer`, which is created if the page has none.
// - `.cf-turnstile` — an optional Turnstile widget container (Cloudflare's own convention); the
//   script refreshes it after each attempt so a retry never resubmits a spent token, and keeps
//   `data-astro-form-turnstile` on it at `visible` while the widget takes up room and `invisible` while it doesn't.
//
// ## Direct uploads (opt-in)
//
// - `data-astro-form-upload-action` on the `<form>` — the upload route (see `createUploadRoute`). With it,
//   file inputs marked `data-astro-form-upload` never join a submission; when any of them holds files, a
//   submit first asks the upload route where to send each one, uploads them with progress, refreshes
//   Turnstile, then posts the form with one receipt per file.
// - `data-astro-form-upload-field` on the `<form>` — the field the file descriptors are posted to the upload
//   route under. Default `uploads`, matching `createUploadRoute`'s `field`.
// - `data-astro-form-upload-receipt-field` on the `<form>` — the field the receipts are posted under.
//   Default `upload`, matching the `UploadedFiles` enricher.
// - `data-astro-form-message-uploading` on the status element — the copy shown while files upload, with
//   `{current}`, `{total}` and `{percent}` filled in, as each file starts and at each 25%.
// - `astro-form:upload-progress` — emitted on the form as bytes go up, with
//   `{ current, total, loaded, size, percent }`.
// - A form has one direct-upload input: when several are marked, the first is used, the rest are left as ordinary
//   file inputs, and the console warns once.
//
// ## File fields (opt-in)
//
// - `[data-astro-form-file-list-for="<name>"]` — a list for the named file input, holding a `<template>` for one
//   item, whose `data-astro-form-file-{name,size,problem,remove}` slots are filled or wired per chosen file. With
//   it, picks accumulate, files can be removed, and each is checked against the input's `accept` and
//   `data-astro-form-max-{files,file-bytes,total-bytes}`; the form sends nothing while a file has a problem.
// - `data-astro-form-message-{too-many-files,file-too-large,files-too-large,file-type,file-required}` on the
//   input — the copy for each problem, with `{maxFiles}`, `{maxFileSize}`, `{maxTotalSize}` and `{types}`, which
//   is the input's `data-astro-form-accepted-types` (written by `uploadInputAttributes`) when it has one.
// - `[data-astro-form-file-drop-for="<name>"]` — an element in the form that takes files dropped on it as if they were
//   picked; the file input itself takes drops too, and a drop zone alone, with no list, makes the field managed. A target shows `data-astro-form-file-drop="active"` while a file is
//   dragged over it. A single-file input keeps the first file of a drop and says so, in
//   `data-astro-form-message-only-one-file`. While any target exists, a file dropped anywhere else on the page is
//   cancelled rather than opened by the browser.
// - `data-astro-form-file-state="invalid"` on a flagged item, and `data-astro-form-invalid` on the list while the
//   field is `aria-invalid`.
// - `[data-astro-form-file-progress]` — a slot in a list item, and `[data-astro-form-upload-progress-for="<name>"]` —
//   a part of the form for the whole field. For a direct upload only, a `<progress>` has its `value` and `max` set
//   (bytes sent and total) and any other element has `--astro-form-progress` (0 to 1) set, and each carries
//   `data-astro-form-file-state` of `uploading` or `done`; a failed or refused upload returns them to 0 and takes
//   the state off.
// - `[data-astro-form-requires-script]` — anything the site renders `hidden` that needs the script, a direct-upload
//   field say; the script removes `hidden` from each such element inside a form when it binds the form.

import { attachFormAnalytics } from './analytics.js'
import { registerFormPart } from './binding.js'
import { checkDirectUploadMarkup } from './direct-uploads.js'
import { attachFileFields } from './file-field-controller.js'
import { revealScriptOnlyParts } from './script-only-parts.js'
import { attachTurnstileState } from './turnstile-state.js'

export { initializeForms } from './binding.js'

registerFormPart(revealScriptOnlyParts)
registerFormPart(checkDirectUploadMarkup)
registerFormPart(attachFileFields)
registerFormPart(attachFormAnalytics)
registerFormPart(attachTurnstileState)

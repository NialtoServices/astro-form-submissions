import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Dispatcher } from '#dispatchers/dispatcher.js'
import { EmailDispatcher, type EmailTransport } from '#dispatchers/index.js'
import { submissionNotificationTemplates } from '#dispatchers/submission-notification.js'
import type { Enricher, FileLink } from '#enrichers/index.js'
import { createFormRoute } from '#route.js'
import { describe, expectTypeOf, it } from 'vitest'

// The resource-threading contract is a compile-time guarantee, so these assertions are the test: they
// run as no-ops but `tsc` (npm run check) enforces every `@ts-expect-error` and typed assignment. They
// mirror the two type spikes, including the extra inference hop through the email templates object.

type Enquiry = { name: string; email: string }

const schema: StandardSchemaV1<Record<string, unknown>, Enquiry> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value: value as Enquiry }) }
}

const filesEnricher: Enricher<Enquiry, { files: FileLink[] }> = {
  enrich: async () => ({ provide: { files: [] } })
}

const needsFiles: Dispatcher<Enquiry, { files: FileLink[] }> = {
  dispatch: async (_submission, context) => {
    // A hand-written dispatcher reads the acquired resource, typed, with no cast.
    expectTypeOf(context.resources.files).toEqualTypeOf<FileLink[]>()
  }
}

const needsAttachments: Dispatcher<Enquiry, { attachments: FileLink[] }> = { dispatch: async () => {} }
const needsNothing: Dispatcher<Enquiry> = { dispatch: async () => {} }

describe('resource threading types', () => {
  it('checks a dispatcher against what the enrichers provide', () => {
    // (1) Happy: an enricher provides `files` and a dispatcher reads `files`.
    createFormRoute({ schema, enrichers: [filesEnricher], dispatchers: [needsFiles] })

    // (2) No enrichers, and a dispatcher that reads nothing.
    createFormRoute({ schema, dispatchers: [needsNothing] })

    // (3) Mismatch: the enricher provides `files` but the dispatcher reads `attachments`.
    createFormRoute({
      schema,
      enrichers: [filesEnricher],
      // @ts-expect-error a dispatcher reading `attachments` has no enricher providing it
      dispatchers: [needsAttachments]
    })

    // (4) Missing provider: a dispatcher reads `files` but no enricher provides it.
    createFormRoute({
      schema,
      // @ts-expect-error a dispatcher reading `files` has no enricher providing it
      dispatchers: [needsFiles]
    })
  })

  it('infers the resource a built-in email needs through its templates', () => {
    const transport: EmailTransport = { deliver: async () => {} }

    // The `attachments` key flows: templates -> EmailDispatcher's resource type -> the route check.
    const templates = submissionNotificationTemplates<Enquiry, 'files'>({ fields: ['name'], attachments: 'files' })
    const email = new EmailDispatcher({ transport, templates, from: 'a@b.test', to: 'c@d.test' })

    // The dispatcher's resource type was inferred as `{ files: FileLink[] }`, not `{}`.
    const asDispatcher: Dispatcher<Enquiry, { files: FileLink[] }> = email
    void asDispatcher

    createFormRoute({ schema, enrichers: [filesEnricher], dispatchers: [email] })

    // Without an enricher providing `files`, the same email fails the route check.
    createFormRoute({
      schema,
      // @ts-expect-error the notification email reads `files` but nothing provides it
      dispatchers: [email]
    })
  })

  it('requires the resource-key type arg when the submission type is given explicitly', () => {
    // Passing `<Enquiry>` alone fixes the submission type but leaves the key param at its `never`
    // default, so an `attachments` key needs both args (`<Enquiry, 'files'>`), as above.
    // @ts-expect-error explicit submission type without the key arg rejects `attachments`
    submissionNotificationTemplates<Enquiry>({ fields: ['name'], attachments: 'files' })
  })
})

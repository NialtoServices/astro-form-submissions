import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Dispatcher } from '#dispatchers/dispatcher.js'
import { EmailDispatcher, type AttachableKey, type EmailTransport } from '#dispatchers/index.js'
import { submissionNotificationTemplates } from '#dispatchers/submission-notification.js'
import { FileAttachments, FileUploads, type AttachedFile, type Enricher, type FileLink } from '#enrichers/index.js'
import { createFormRoute } from '#route.js'
import { describe, expect, expectTypeOf, it } from 'vitest'

// The resource-threading contract is a compile-time guarantee, so these assertions are the test: they
// run as no-ops but `tsc` (`pnpm check`) enforces every `@ts-expect-error` and typed assignment,
// including the extra inference hop through the email templates object.

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

  it('checks every dispatcher in every group against what the enrichers provide', () => {
    // Happy: groups of correctly typed dispatchers.
    createFormRoute({ schema, enrichers: [filesEnricher], dispatchers: [[needsFiles], [needsNothing]] })

    // Mismatch inside a later group is still caught.
    createFormRoute({
      schema,
      enrichers: [filesEnricher],
      // @ts-expect-error a grouped dispatcher reading `attachments` has no enricher providing it
      dispatchers: [[needsFiles], [needsAttachments]]
    })

    // A mix of the flat and grouped shapes is rejected, and throws for a caller that gets past the types.
    expect(() =>
      createFormRoute({
        schema,
        // @ts-expect-error dispatchers must be all dispatchers or all groups
        dispatchers: [needsNothing, [needsNothing]]
      })
    ).toThrow(TypeError)
  })

  it('accepts readonly dispatcher lists and groups, as it does enrichers', () => {
    const flat = [needsNothing] as const
    const groups = [[needsFiles], [needsNothing]] as const

    createFormRoute({ schema, dispatchers: flat })
    createFormRoute({ schema, enrichers: [filesEnricher], dispatchers: groups })

    // Readonly does not loosen the resource check.
    // @ts-expect-error a grouped dispatcher reading `files` has no enricher providing it
    createFormRoute({ schema, dispatchers: groups })
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

  describe('email attachments', () => {
    const transport: EmailTransport = { deliver: async () => {} }
    const plainTemplates = submissionNotificationTemplates<Enquiry>({ fields: ['name'] })
    const fileAttachments = new FileAttachments<Enquiry>()
    const fileUploads = new FileUploads<Enquiry>({
      storage: { put: async () => {}, get: async () => null, delete: async () => {} },
      link: async (stored) => `https://example.com/files/${stored.objectKey}/`
    })

    it('names the resource keys that hold attachable files', () => {
      expectTypeOf<
        AttachableKey<{ cv: AttachedFile[]; photos: readonly AttachedFile[]; links: FileLink[] }>
      >().toEqualTypeOf<'cv' | 'photos'>()
    })

    it("checks an email's attach key against what the enrichers provide", () => {
      const attaching = new EmailDispatcher({
        transport,
        templates: plainTemplates,
        from: 'a@b.test',
        to: 'c@d.test',
        attach: 'files'
      })

      // The attach key flows into the dispatcher's resource type, as the templates' keys do.
      const asDispatcher: Dispatcher<Enquiry, { files: readonly AttachedFile[] }> = attaching
      void asDispatcher

      createFormRoute({ schema, enrichers: [fileAttachments], dispatchers: [attaching] })

      createFormRoute({
        schema,
        // @ts-expect-error the email attaches `files` but nothing provides it
        dispatchers: [attaching]
      })

      createFormRoute({
        schema,
        enrichers: [fileUploads],
        // @ts-expect-error `files` holds FileUploads links, which can't be attached
        dispatchers: [attaching]
      })
    })

    it("refuses a FileAttachments key as the templates' attachments", () => {
      const linking = new EmailDispatcher({
        transport,
        templates: submissionNotificationTemplates<Enquiry, 'files'>({ fields: ['name'], attachments: 'files' }),
        from: 'a@b.test',
        to: 'c@d.test'
      })

      createFormRoute({
        schema,
        enrichers: [fileAttachments],
        // @ts-expect-error `files` holds attached files, which the templates can't render as links
        dispatchers: [linking]
      })
    })

    it('lets one email attach one key and link another', () => {
      const email = new EmailDispatcher({
        transport,
        templates: submissionNotificationTemplates<Enquiry, 'files'>({ fields: ['name'], attachments: 'files' }),
        from: 'a@b.test',
        to: 'c@d.test',
        attach: 'cv'
      })

      createFormRoute({
        schema,
        enrichers: [fileUploads, new FileAttachments<Enquiry, 'cv'>({ field: 'cv', attachTo: 'cv' })],
        dispatchers: [email]
      })
    })
  })

  it('requires the resource-key type arg when the submission type is given explicitly', () => {
    // Passing `<Enquiry>` alone fixes the submission type but leaves the key param at its `never`
    // default, so an `attachments` key needs both args (`<Enquiry, 'files'>`), as above.
    // @ts-expect-error explicit submission type without the key arg rejects `attachments`
    submissionNotificationTemplates<Enquiry>({ fields: ['name'], attachments: 'files' })
  })
})

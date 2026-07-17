import type { StandardSchemaV1 } from '@standard-schema/spec'
import { submissionNotificationTemplates } from '#dispatchers/submission-notification.js'
import type { Submission } from '#schema.js'
import { describe, expectTypeOf, it } from 'vitest'

// `Submission<S>` must expose the schema's real key union, not a widened `string | number`, so a
// `fields` list (or any `keyof E & string` position) rejects typos. These are compile-time assertions:
// they run as no-ops but `tsc` (npm run check) enforces every `@ts-expect-error`. Regression guard for
// the `& FormSubmission` intersection, which widened `keyof` and silently accepted non-existent keys.

type Enquiry = { name: string; email: string; message: string }
type EnquirySchema = StandardSchemaV1<Record<string, unknown>, Enquiry>
type EnquirySubmission = Submission<EnquirySchema>

describe('Submission<S> key inference', () => {
  it('resolves to the schema output real key union', () => {
    expectTypeOf<keyof EnquirySubmission>().toEqualTypeOf<'name' | 'email' | 'message'>()
  })

  it('does not admit an arbitrary string as a key', () => {
    // @ts-expect-error a non-existent field is not a key of the submission
    const bad: keyof EnquirySubmission = 'definitelyNotAField'
    void bad
  })

  it('constrains a fields list to the submission own keys', () => {
    submissionNotificationTemplates<EnquirySubmission>({ fields: ['name', 'email', 'message'] })

    submissionNotificationTemplates<EnquirySubmission>({
      // @ts-expect-error 'naame' is a typo — not a key of the submission
      fields: ['naame', 'email']
    })
  })
})

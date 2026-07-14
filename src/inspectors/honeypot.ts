import { getField } from '#form-data.js'
import { type InspectionContext, type Inspector } from '#inspectors/inspector.js'
import { type FormSubmission, type Verdict } from '#pipeline.js'

/** Options for constructing a {@link HoneypotInspector}. */
export interface HoneypotInspectorOptions {
  /**
   * Honeypot field name — must match the `name` of the hidden honeypot `<input>` the site renders in
   * its form. Pick a name a bot will happily fill but the site never legitimately collects.
   */
  fieldName: string
}

/**
 * Silently drops submissions whose honeypot field is filled. The site renders a visually hidden
 * input a real user never fills; a bot that blindly fills every input trips it.
 *
 * Place this **first** in `inspectors` so bot submissions are dropped before more expensive inspectors
 * (e.g. a network round-trip to a verification service) run. The drop is silent — the bot sees the same
 * success a real submission would, and never learns it was detected.
 */
export class HoneypotInspector implements Inspector {
  // MARK: - Object Lifecycle

  /**
   * Creates a honeypot inspector.
   *
   * @param options - The inspector options, including the honeypot field name.
   */
  constructor(private readonly options: HoneypotInspectorOptions) {}

  // MARK: - Inspector API

  /**
   * Inspects the submission's honeypot field.
   *
   * @param context - The inspection context; reads the honeypot field from the raw form data.
   * @returns `{ action: 'drop' }` when the honeypot is filled, otherwise `{ action: 'accept' }`.
   */
  async inspect(context: InspectionContext<FormSubmission>): Promise<Verdict> {
    // `getField` trims, so a whitespace-only value (some browsers autofill spaces) doesn't count as filled.
    if (getField(context.data, this.options.fieldName) !== undefined) {
      return { action: 'drop' }
    }

    return { action: 'accept' }
  }
}

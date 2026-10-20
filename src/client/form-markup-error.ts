/**
 * A `[data-astro-form]` form lacks an element the script needs to enhance it. The form is left to post
 * natively, so this is reported as a warning naming the form, not as a failure.
 */
export class FormMarkupError extends Error {
  // MARK: - Object Lifecycle

  constructor(
    readonly formElement: HTMLFormElement,
    readonly missingSelector: string
  ) {
    super(`Not enhancing a form with no ${missingSelector} element inside it.`)
    this.name = 'FormMarkupError'
  }
}

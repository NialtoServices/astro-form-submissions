import { formDataWithoutUploads, submitWithUploads, uploadInputs } from './direct-uploads.js'
import { applyFieldErrors, clearFieldError, clearFieldErrors, renderFieldErrorSummary } from './field-errors.js'
import { FormMarkupError } from './form-markup-error.js'
import {
  postForm,
  resolveSubmissionURL,
  type FormMessages,
  type PostOutcome,
  type SubmissionContext
} from './submission.js'
import { applyTurnstileTokens, resetTurnstileWidget, waitForTurnstileToken } from './turnstile.js'

/** Releases what a form part set up, once its form leaves the page for good. */
export type FormTeardown = () => void

/** What a part attached to a bound form (a file field, say) may use of the form's controller. */
export interface FormPartHost {
  /** The bound form. */
  readonly formElement: HTMLFormElement

  /**
   * Aborted once the form leaves the page for good. A listener a part adds outside the form (on `document`
   * or `window`) passes it as its `signal`, so the listener goes with the form.
   */
  readonly signal: AbortSignal
}

/**
 * Enhances one `[data-astro-form]` form: submits it by `fetch`, presents the outcome in its status element,
 * and keeps its field errors in step with what the visitor edits.
 */
export class FormController implements FormPartHost {
  // MARK: - Properties

  readonly formElement: HTMLFormElement
  private readonly statusElement: HTMLElement
  private readonly successElement: HTMLElement | null
  private readonly messages: FormMessages
  private readonly abortController = new AbortController()
  private readonly teardowns: FormTeardown[] = []

  // MARK: - Object Lifecycle

  /**
   * Resolve the form's status and success elements and copy, set the accessibility defaults, and listen for
   * its input and submit events.
   *
   * @throws {FormMarkupError} When the form has no `[data-astro-form-status]` element inside it.
   */
  constructor(formElement: HTMLFormElement) {
    const statusElement = formElement.querySelector<HTMLElement>('[data-astro-form-status]')
    if (!statusElement) throw new FormMarkupError(formElement, '[data-astro-form-status]')

    this.formElement = formElement
    this.statusElement = statusElement

    // An element carrying `data-astro-form-success` immediately after the form is the (hidden) panel a
    // successful submission swaps the whole <form> out for.
    const siblingElement = formElement.nextElementSibling
    this.successElement =
      siblingElement instanceof HTMLElement && siblingElement.hasAttribute('data-astro-form-success')
        ? siblingElement
        : null

    // Announce status changes to assistive tech even if the site markup omits the attributes.
    if (!statusElement.hasAttribute('role')) statusElement.setAttribute('role', 'status')
    if (!statusElement.hasAttribute('aria-live')) statusElement.setAttribute('aria-live', 'polite')

    const {
      astroFormMessageSending: sending,
      astroFormMessageUploading: uploading,
      astroFormMessageSuccess: success,
      astroFormMessageGenericError: genericError,
      astroFormMessageNetworkError: networkError
    } = statusElement.dataset
    this.messages = { sending, uploading, success, genericError, networkError }

    formElement.dataset.astroFormBound = 'true'
    formElement.addEventListener('input', (event) => this.recoverField(event), { signal: this.signal })
    formElement.addEventListener('submit', (event) => void this.submit(event), { signal: this.signal })
  }

  /**
   * Release the form once it has left the page for good: abort {@link signal}, run every part's teardown, and
   * drop the `data-astro-form-bound` marker, so the form binds afresh if it is ever put back.
   */
  disconnect(): void {
    this.abortController.abort()
    for (const teardown of this.teardowns.splice(0)) {
      try {
        teardown()
      } catch (error) {
        console.warn('[astro-form-submissions] Failed to tear down a form part', error)
      }
    }

    delete this.formElement.dataset.astroFormBound
  }

  // MARK: - Parts

  /** Run `teardown` when the form leaves the page for good. */
  addTeardown(teardown: FormTeardown): void {
    this.teardowns.push(teardown)
  }

  // MARK: - Derived State

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  private get submissionContext(): SubmissionContext {
    return { formElement: this.formElement, statusElement: this.statusElement, messages: this.messages }
  }

  // MARK: - Submission

  /** Handle a submit: guard re-entry, POST via `fetch`, and route the outcome to success or error presentation. */
  private async submit(event: SubmitEvent): Promise<void> {
    const { formElement, statusElement, messages } = this
    event.preventDefault()

    // Guard overlapping submissions (rapid Enter/click) beyond any disabled control.
    if (formElement.dataset.astroFormSubmitting) return

    // The control that actually triggered submission (click, Enter, `requestSubmit(control)`).
    // Standard HTML semantics: its name/value joins the payload and it is the one disabled.
    const submitterElement =
      event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement
        ? event.submitter
        : null

    // Direct-upload inputs never join a submission; their files go up in steps of their own. Empty files
    // are skipped, as `FileUploads` skips them on the multipart path, since the upload route refuses them.
    const uploadAction = formElement.dataset.astroFormUploadAction
    const files = uploadAction
      ? uploadInputs(formElement)
          .flatMap((inputElement) => Array.from(inputElement.files ?? []))
          .filter((file) => file.size > 0)
      : []

    // A disabled control is omitted from FormData, so the submitter must still be enabled here.
    const formData = uploadAction
      ? formDataWithoutUploads(formElement, submitterElement)
      : submitterElement
        ? new FormData(formElement, submitterElement)
        : new FormData(formElement)

    // Disabling a focused control drops focus to <body>, and re-enabling it doesn't bring focus back, so a
    // keyboard user would be sent to the top of the page.
    const submitterHadFocus = submitterElement !== null && document.activeElement === submitterElement
    formElement.dataset.astroFormSubmitting = 'true'
    if (submitterElement) submitterElement.disabled = true

    // Wipe prior field marks so a field fixed since the last submit isn't left flagged.
    clearFieldErrors(formElement)
    statusElement.textContent = messages.sending ?? ''
    statusElement.dataset.astroFormState = 'pending'

    let outcome: PostOutcome & { formData?: FormData }
    try {
      const submissionURL = resolveSubmissionURL(formElement, submitterElement)

      // An interaction-only or still-loading widget has no token yet; posting now would spend the attempt
      // on a certain verification failure. The submitting guard above keeps a second click out meanwhile.
      await waitForTurnstileToken(formElement)
      applyTurnstileTokens(formElement, formData)

      outcome =
        uploadAction && files.length > 0
          ? await submitWithUploads(this.submissionContext, uploadAction, submissionURL, formData, files)
          : await postForm(this.submissionContext, submissionURL, formData)
    } catch (error) {
      // Every expected failure resolves to an outcome; anything thrown is a bug or a broken environment
      // (an unparseable `action`, say), and must still end in the error state rather than leave it pending.
      console.warn('[astro-form-submissions] Submission failed unexpectedly', error)
      outcome = { ok: false, error: messages.genericError ?? '' }
    } finally {
      if (submitterElement) submitterElement.disabled = false
      delete formElement.dataset.astroFormSubmitting

      // Presenting the outcome may move focus on purpose (to a field error or the success panel) afterwards.
      const focusLost = document.activeElement === null || document.activeElement === document.body
      if (submitterHadFocus && submitterElement.isConnected && focusLost) submitterElement.focus()
    }

    if (!outcome.ok) {
      this.showError(outcome.error, outcome.fieldErrors)
      return
    }

    // Dispatched before any swap so the form is still in the document for listeners.
    formElement.dispatchEvent(
      new CustomEvent('astro-form:success', { bubbles: true, detail: { data: outcome.formData ?? formData } })
    )
    this.showSuccess()
  }

  // MARK: - Presentation

  /** Present a rejection: set the error status, mark and annotate the faulty fields, refresh Turnstile, and emit `astro-form:error`. */
  private showError(error: string, fieldErrors: Record<string, string> = {}): void {
    const { formElement, statusElement } = this
    statusElement.textContent = error
    statusElement.dataset.astroFormState = 'error'
    const firstInvalidElement = applyFieldErrors(formElement, fieldErrors)
    const summaryElement = renderFieldErrorSummary(formElement, fieldErrors)

    // Prefer the summary list for the multi-error overview; otherwise land the user on the first
    // field to fix.
    ;(summaryElement ?? firstInvalidElement)?.focus()

    // The server consumes the Turnstile token before dispatching, so the widget must refresh
    // after any attempt — otherwise a retry resubmits a spent token, rejected as a duplicate.
    resetTurnstileWidget(formElement)
    formElement.dispatchEvent(new CustomEvent('astro-form:error', { bubbles: true, detail: { error, fieldErrors } }))
  }

  /**
   * Present a confirmed success: swap the form out for the `[data-astro-form-success]` panel when one follows
   * it, otherwise show the success copy and reset. Best-effort — a failing swap, focus, or reset must not
   * re-enter the error path and invite a duplicate send.
   */
  private showSuccess(): void {
    const { formElement, statusElement, successElement, messages } = this
    try {
      if (successElement) {
        successElement.hidden = false
        formElement.replaceWith(successElement)

        // The status live-region left with the form; focusing the panel announces it instead. A
        // non-interactive panel needs a tabindex to take that focus; a site-supplied one is left alone.
        if (!successElement.hasAttribute('tabindex')) successElement.setAttribute('tabindex', '-1')
        successElement.focus()
      } else {
        statusElement.textContent = messages.success ?? ''
        statusElement.dataset.astroFormState = 'success'

        // Called through the prototype because a control named `reset` shadows `formElement.reset`.
        HTMLFormElement.prototype.reset.call(formElement)
        resetTurnstileWidget(formElement)
      }
    } catch (error) {
      console.warn('[astro-form-submissions] Failed to present the success state', error)
    }
  }

  // MARK: - Progressive Recovery

  /**
   * Drop the edited field's invalid mark, inline message, and summary entry as soon as the user edits it, so
   * the error state tracks what they're fixing rather than persisting until the next submit.
   */
  private recoverField(event: Event): void {
    const targetElement = event.target instanceof HTMLElement ? event.target : null
    const name = targetElement?.getAttribute('name')
    if (!name) return

    clearFieldError(this.formElement, name)
  }
}

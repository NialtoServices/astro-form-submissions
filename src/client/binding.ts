import { FormController } from './form-controller.js'
import { FormMarkupError } from './form-markup-error.js'

// MARK: - Binding

/**
 * Enhance one form, reporting a form the script can't enhance rather than throwing, so one broken form never
 * stops the others binding.
 */
function bindForm(formElement: HTMLFormElement): void {
  try {
    new FormController(formElement)
  } catch (error) {
    // Unenhanced, the form posts natively and the visitor lands on the route's raw JSON, so the cause has to
    // surface somewhere a developer will look.
    if (error instanceof FormMarkupError) {
      console.warn(`[astro-form-submissions] ${error.message}`, error.formElement)
      return
    }

    console.error('Failed to initialize FormController', error)
  }
}

/**
 * Binds the submit handler to every unbound `[data-astro-form]` form in the document.
 *
 * Safe to call repeatedly (e.g. after Astro View Transitions swap the DOM): already-bound
 * forms are skipped via a `data-astro-form-bound` marker. A form the script can't enhance is left
 * unmarked with a console warning, so a later call retries it.
 */
export function initializeForms(): void {
  for (const formElement of document.querySelectorAll<HTMLFormElement>('form[data-astro-form]')) {
    // `initializeForms` is re-invoked on every `astro:page-load` navigation; bind each form only once.
    if (formElement.dataset.astroFormBound) continue

    bindForm(formElement)
  }
}

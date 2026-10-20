import { FormController, type FormPartHost, type FormTeardown } from './form-controller.js'
import { FormMarkupError } from './form-markup-error.js'

// MARK: - Types

/**
 * Attaches one part (a file field's controller, say) to a bound form. Called once per bound form, with the
 * form and its controller; returns what releases the part when the form leaves the page for good, if anything
 * needs releasing.
 */
export type FormPartFactory = (formElement: HTMLFormElement, formController: FormPartHost) => FormTeardown | void

// MARK: - State

const FORM_SELECTOR = 'form[data-astro-form]'

const formPartFactories: FormPartFactory[] = []

/** Every form bound and still on the page, with its controller. */
const formControllers = new Map<HTMLFormElement, FormController>()

/** Watches for forms added after the first `initializeForms` call, and for bound forms leaving the page. */
let formObserver: MutationObserver | undefined

// MARK: - Parts

/**
 * Attach a part to every bound form: those bound already and every form bound from now on. Internal to the
 * package; the client modules that add behaviour to a form register through it.
 */
export function registerFormPart(factory: FormPartFactory): void {
  formPartFactories.push(factory)
  for (const formController of formControllers.values()) attachFormPart(formController, factory)
}

/** Attach one part to one form, so a part that fails leaves the form, and its other parts, working. */
function attachFormPart(formController: FormController, factory: FormPartFactory): void {
  try {
    const teardown = factory(formController.formElement, formController)
    if (teardown) formController.addTeardown(teardown)
  } catch (error) {
    console.error('Failed to initialize a form part', error)
  }
}

// MARK: - Binding

/**
 * Enhance one form unless it is bound already, reporting a form the script can't enhance rather than
 * throwing, so one broken form never stops the others binding.
 */
function bindForm(formElement: HTMLFormElement): void {
  // A form is seen again whenever `initializeForms` runs (on every `astro:page-load`) and whenever it is
  // moved, which the observer reports as an addition; it binds only once.
  if (formElement.dataset.astroFormBound || formControllers.has(formElement)) return

  let formController: FormController
  try {
    formController = new FormController(formElement)
  } catch (error) {
    // Unenhanced, the form posts natively and the visitor lands on the route's raw JSON, so the cause has to
    // surface somewhere a developer will look.
    if (error instanceof FormMarkupError) {
      console.warn(`[astro-form-submissions] ${error.message}`, error.formElement)
      return
    }

    console.error('Failed to initialize FormController', error)
    return
  }

  formControllers.set(formElement, formController)
  for (const factory of formPartFactories) attachFormPart(formController, factory)
}

/** Bind every `[data-astro-form]` form at or inside `rootNode`. */
function bindFormsWithin(rootNode: Document | Element): void {
  if (rootNode instanceof HTMLFormElement && rootNode.matches(FORM_SELECTOR)) bindForm(rootNode)
  for (const formElement of rootNode.querySelectorAll<HTMLFormElement>(FORM_SELECTOR)) bindForm(formElement)
}

/** Release every bound form no longer on the page. */
function releaseDetachedForms(): void {
  for (const [formElement, formController] of formControllers) {
    if (formElement.isConnected) continue

    formControllers.delete(formElement)
    formController.disconnect()
  }
}

/** Bind the forms a batch of mutations added, and schedule the release of any it removed. */
function handleMutations(records: MutationRecord[]): void {
  let removedNodes = false
  for (const record of records) {
    if (record.removedNodes.length > 0) removedNodes = true
    for (const addedNode of record.addedNodes) {
      if (addedNode instanceof Element && addedNode.isConnected) bindFormsWithin(addedNode)
    }
  }

  // A form moved within the page (a drawer re-parenting its content) is removed and put back, possibly across
  // an await; checking a microtask after the batch keeps its controller rather than tearing it down.
  if (removedNodes) queueMicrotask(releaseDetachedForms)
}

// MARK: - Initialisation

/**
 * Binds the submit handler to every unbound `[data-astro-form]` form in the document, and from the first call
 * on, to every such form added to the page later. A bound form moved within the page keeps its state; one
 * removed for good is released.
 *
 * Safe to call repeatedly (e.g. after Astro View Transitions swap the DOM): already-bound
 * forms are skipped via a `data-astro-form-bound` marker. A form the script can't enhance is left
 * unmarked with a console warning, so a later call retries it.
 */
export function initializeForms(): void {
  bindFormsWithin(document)
  if (formObserver) return

  formObserver = new MutationObserver(handleMutations)
  formObserver.observe(document, { childList: true, subtree: true })
}

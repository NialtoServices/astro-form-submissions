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

/** The pending release of bound forms that have left the page, at most one at a time. */
let releaseTimer: ReturnType<typeof setTimeout> | undefined

/** Forms already warned about, so retrying an incomplete form doesn't repeat its warning. */
const warnedFormElements = new WeakSet<HTMLFormElement>()

/** Forms whose warning waits for the document to finish parsing. */
const heldFormElements = new WeakSet<HTMLFormElement>()

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
    console.error('[astro-form-submissions] Failed to initialize a form part', error)
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
    if (error instanceof FormMarkupError) {
      warnAboutMarkup(error)
      return
    }

    console.error('[astro-form-submissions] Failed to initialize FormController', error)
    return
  }

  formControllers.set(formElement, formController)
  for (const factory of formPartFactories) attachFormPart(formController, factory)
}

/**
 * Warn, once per form, that a form can't be enhanced. Unenhanced, the form posts natively and the visitor lands
 * on the route's raw JSON, so the cause has to surface somewhere a developer will look.
 */
function warnAboutMarkup(error: FormMarkupError): void {
  const { formElement } = error
  if (warnedFormElements.has(formElement) || heldFormElements.has(formElement)) return

  // While the document is still parsing, the parser may yet add the missing element, and the observer then
  // binds the form, so the form is judged once parsing ends.
  if (document.readyState === 'loading') {
    heldFormElements.add(formElement)
    const judgeForm = () => {
      heldFormElements.delete(formElement)
      if (formElement.isConnected && !formElement.dataset.astroFormBound) warnAboutMarkup(error)
    }
    document.addEventListener('DOMContentLoaded', judgeForm, { once: true })
    return
  }

  warnedFormElements.add(formElement)
  console.warn(`[astro-form-submissions] ${error.message}`, formElement)
}

/** Bind every `[data-astro-form]` form at or inside `rootNode`. */
function bindFormsWithin(rootNode: Document | Element): void {
  if (rootNode instanceof HTMLFormElement && rootNode.matches(FORM_SELECTOR)) bindForm(rootNode)
  for (const formElement of rootNode.querySelectorAll<HTMLFormElement>(FORM_SELECTOR)) bindForm(formElement)
}

/** Release every bound form no longer on the page. */
function releaseDetachedForms(): void {
  releaseTimer = undefined
  for (const [formElement, formController] of formControllers) {
    if (formElement.isConnected) continue

    formControllers.delete(formElement)
    formController.disconnect()
  }
}

/**
 * Bind the forms a batch of mutations added, retry an unbound form that gained content (its missing status
 * element, say), and schedule the release of any bound form it removed.
 */
function handleMutations(records: MutationRecord[]): void {
  let removedNodes = false
  for (const record of records) {
    if (record.removedNodes.length > 0) removedNodes = true
    for (const addedNode of record.addedNodes) {
      if (!(addedNode instanceof Element) || !addedNode.isConnected) continue

      bindFormsWithin(addedNode)

      // An unbound form retries as content arrives in it, since the arrival may be its missing status element.
      const enclosingFormElement =
        addedNode instanceof HTMLFormElement ? null : addedNode.closest<HTMLFormElement>(FORM_SELECTOR)
      if (enclosingFormElement) bindForm(enclosingFormElement)
    }
  }

  if (!removedNodes || formControllers.size === 0 || releaseTimer !== undefined) return

  // A form moved within the page (a drawer re-parenting its content) is removed and put back within one task,
  // however many awaits apart; judging detachment in a later task keeps its controller rather than tearing it
  // down.
  releaseTimer = setTimeout(releaseDetachedForms, 0)
}

// MARK: - Initialisation

/**
 * Binds the submit handler to every unbound `[data-astro-form]` form in the document, and from the first call
 * on, to every such form added to the page later. A bound form moved within the page keeps its state; one
 * removed for good is released.
 *
 * Safe to call repeatedly (e.g. after Astro View Transitions swap the DOM): already-bound
 * forms are skipped via a `data-astro-form-bound` marker. A form the script can't enhance is left
 * unmarked with one console warning, and binds once its missing element is added.
 */
export function initializeForms(): void {
  bindFormsWithin(document)
  if (formObserver) return

  formObserver = new MutationObserver(handleMutations)
  formObserver.observe(document, { childList: true, subtree: true })
}

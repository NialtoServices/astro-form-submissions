// MARK: - Described-By Links

/**
 * Holds the slot id the script added to an input's `aria-describedby`, so clearing removes exactly that
 * token and leaves any author-set ones (a hint, say) in place.
 */
const DESCRIBED_MARKER = 'astroFormDescribed'

/** The ids in an input's `aria-describedby`. */
function describedByTokens(inputElement: HTMLElement): string[] {
  return (inputElement.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
}

/** Add an error slot's id to an input's `aria-describedby`, after any ids the author set. */
function addDescribedBy(inputElement: HTMLElement, slotId: string): void {
  const tokens = describedByTokens(inputElement)
  if (tokens.includes(slotId)) return

  inputElement.setAttribute('aria-describedby', [...tokens, slotId].join(' '))
  inputElement.dataset[DESCRIBED_MARKER] = slotId
}

/** Drop the slot id the script added to an input's `aria-describedby`, leaving any author-set ids intact. */
function clearDescribedBy(inputElement: HTMLElement): void {
  const slotId = inputElement.dataset[DESCRIBED_MARKER]
  if (slotId === undefined) return

  const tokens = describedByTokens(inputElement).filter((token) => token !== slotId)
  if (tokens.length > 0) {
    inputElement.setAttribute('aria-describedby', tokens.join(' '))
  } else {
    inputElement.removeAttribute('aria-describedby')
  }

  delete inputElement.dataset[DESCRIBED_MARKER]
}

// MARK: - Disabled Controls

/**
 * The controls sharing `name` that can take an error: those not disabled, directly or through a disabled
 * `<fieldset>`. A disabled control is left out of the submission, so no error of the server's can be about it.
 */
function enabledControls(formElement: HTMLFormElement, name: string): HTMLElement[] {
  return Array.from(formElement.querySelectorAll<HTMLElement>(`[name="${CSS.escape(name)}"]`)).filter(
    (inputElement) => !inputElement.matches(':disabled')
  )
}

/** Whether the form has controls named `name`, and every one of them is disabled. */
function isEveryControlDisabled(formElement: HTMLFormElement, name: string): boolean {
  return (
    formElement.querySelector(`[name="${CSS.escape(name)}"]`) !== null &&
    enabledControls(formElement, name).length === 0
  )
}

// MARK: - Presentation

/**
 * Mark each faulty field `aria-invalid` and, where a co-located `[data-astro-form-field-error-for]` slot
 * sits beside it, fill that slot and link it via `aria-describedby` (read on focus, so it is deliberately
 * not a live region — the summary already announces). Every control sharing the name is marked, so a
 * radio or checkbox group is flagged as a whole. A disabled control is skipped, and a field with none enabled
 * is passed over. Returns the first invalid control, for focus.
 */
export function applyFieldErrors(
  formElement: HTMLFormElement,
  fieldErrors: Record<string, string>
): HTMLElement | null {
  let firstInvalidElement: HTMLElement | null = null
  for (const [name, message] of Object.entries(fieldErrors)) {
    const inputElements = enabledControls(formElement, name)
    if (inputElements.length === 0) continue

    for (const inputElement of inputElements) inputElement.setAttribute('aria-invalid', 'true')
    firstInvalidElement ??= inputElements[0] ?? null

    const slotElement = formElement.querySelector<HTMLElement>(
      `[data-astro-form-field-error-for="${CSS.escape(name)}"]`
    )
    if (!slotElement) continue

    slotElement.textContent = message
    slotElement.hidden = false

    const slotId = slotElement.id
    if (slotId) for (const inputElement of inputElements) addDescribedBy(inputElement, slotId)
  }
  return firstInvalidElement
}

/**
 * Fill the central `[data-astro-form-field-error-summary]` element with a list of every field's message,
 * each linking to its field. A field whose controls are all disabled is left out. Returns the summary to focus,
 * or `null` when the markup provides none or there is nothing to list.
 */
export function renderFieldErrorSummary(
  formElement: HTMLFormElement,
  fieldErrors: Record<string, string>
): HTMLElement | null {
  const summaryElement = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
  if (!summaryElement) return null

  summaryElement.textContent = ''
  const entries = Object.entries(fieldErrors).filter(([name]) => !isEveryControlDisabled(formElement, name))
  if (entries.length === 0) {
    summaryElement.hidden = true
    return null
  }

  const listElement = document.createElement('ul')
  for (const [name, message] of entries) {
    const itemElement = document.createElement('li')

    // Tag the item with its field so progressive recovery can remove exactly this entry on input.
    itemElement.dataset.astroFormSummaryItem = name
    const inputElement = enabledControls(formElement, name)[0]
    if (inputElement) {
      // An anchor without `href` isn't a link to a keyboard or a screen reader, so a field with no `id` still
      // gets one; the click handler, which Enter also fires, does the focusing either way.
      const linkElement = document.createElement('a')
      linkElement.href = inputElement.id ? `#${inputElement.id}` : '#'
      linkElement.textContent = message
      linkElement.addEventListener('click', (event) => {
        event.preventDefault()
        inputElement.focus()
      })
      itemElement.append(linkElement)
    } else {
      itemElement.textContent = message
    }
    listElement.append(itemElement)
  }
  summaryElement.append(listElement)
  summaryElement.hidden = false

  // A non-interactive container needs a tabindex to receive the programmatic focus below; a
  // site-supplied one is left alone so a real tabstop isn't clobbered.
  if (!summaryElement.hasAttribute('tabindex')) summaryElement.setAttribute('tabindex', '-1')
  return summaryElement
}

// MARK: - Clearing

/** Clear every field's invalid state, empty its slot, and empty the summary list — on resubmit. */
export function clearFieldErrors(formElement: HTMLFormElement): void {
  for (const inputElement of formElement.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    inputElement.removeAttribute('aria-invalid')
    clearDescribedBy(inputElement)
  }
  for (const slotElement of formElement.querySelectorAll<HTMLElement>('[data-astro-form-field-error-for]')) {
    slotElement.textContent = ''
    slotElement.hidden = true
  }
  const summaryElement = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
  if (summaryElement) {
    summaryElement.textContent = ''
    summaryElement.hidden = true
  }
}

/**
 * Drop one field's invalid mark, inline message, and summary entry, hiding the summary once its last entry
 * goes. Does nothing when no control by that name is marked invalid.
 */
export function clearFieldError(formElement: HTMLFormElement, name: string): void {
  // The whole group recovers together: a radio group's error clears whichever of its options is edited.
  const invalidElements = formElement.querySelectorAll<HTMLElement>(`[name="${CSS.escape(name)}"][aria-invalid="true"]`)
  if (invalidElements.length === 0) return

  for (const invalidElement of invalidElements) {
    invalidElement.removeAttribute('aria-invalid')
    clearDescribedBy(invalidElement)
  }

  clearFieldMessages(formElement, name)
}

/**
 * Drop the disabled controls' invalid marks, and for each field left with no invalid control, its inline message
 * and summary entry. Called when a site disables a field or a `<fieldset>`: the field is no longer part of the
 * submission, so an error about it no longer applies.
 */
export function clearDisabledFieldErrors(formElement: HTMLFormElement): void {
  const clearedNames = new Set<string>()
  for (const invalidElement of formElement.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    if (!invalidElement.matches(':disabled')) continue

    invalidElement.removeAttribute('aria-invalid')
    clearDescribedBy(invalidElement)

    const name = invalidElement.getAttribute('name')
    if (name) clearedNames.add(name)
  }

  // A radio group with an option still enabled keeps its message.
  for (const name of clearedNames) {
    if (formElement.querySelector(`[name="${CSS.escape(name)}"][aria-invalid="true"]`)) continue

    clearFieldMessages(formElement, name)
  }
}

/** Empty one field's inline slot and remove its summary entry, hiding the summary once its last entry goes. */
function clearFieldMessages(formElement: HTMLFormElement, name: string): void {
  const slotElement = formElement.querySelector<HTMLElement>(`[data-astro-form-field-error-for="${CSS.escape(name)}"]`)
  if (slotElement) {
    slotElement.textContent = ''
    slotElement.hidden = true
  }

  // Drop this field's entry from the central summary too, and hide the summary once its last entry
  // goes — otherwise a corrected field keeps claiming it's invalid in the overview and to AT.
  const summaryElement = formElement.querySelector<HTMLElement>('[data-astro-form-field-error-summary]')
  if (summaryElement) {
    summaryElement.querySelector(`[data-astro-form-summary-item="${CSS.escape(name)}"]`)?.remove()
    if (!summaryElement.querySelector('[data-astro-form-summary-item]')) {
      summaryElement.textContent = ''
      summaryElement.hidden = true
    }
  }
}

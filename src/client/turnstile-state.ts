import type { FormPartHost } from './form-controller.js'

/**
 * Keeps `data-astro-form-turnstile` on each of the form's `.cf-turnstile` containers at `visible` while the
 * widget takes up room and `invisible` while it doesn't, so a site can collapse the space around a widget that
 * shows nothing until it needs the visitor (an interaction-only or execute widget). A form without a container
 * gets no attribute.
 *
 * The measure is the container's content box, so a site's padding and borders never count; a container with a
 * `min-height` of its own always reads as visible, which is why a site styles a wrapper instead.
 */
export function attachTurnstileState(formElement: HTMLFormElement, formController: FormPartHost): void {
  if (typeof ResizeObserver === 'undefined') return

  const containerElements = formElement.querySelectorAll<HTMLElement>('.cf-turnstile')
  if (containerElements.length === 0) return

  // Before the loader renders a widget the container holds nothing, so it starts out invisible.
  for (const containerElement of containerElements) containerElement.dataset.astroFormTurnstile = 'invisible'

  const resizeObserver = new ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      if (!(target instanceof HTMLElement)) continue

      target.dataset.astroFormTurnstile = contentRect.width > 0 && contentRect.height > 0 ? 'visible' : 'invisible'
    }
  })
  for (const containerElement of containerElements) resizeObserver.observe(containerElement)

  formController.signal.addEventListener('abort', () => resizeObserver.disconnect(), { once: true })
}

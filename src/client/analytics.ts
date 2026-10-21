import type { FormPartHost } from './form-controller.js'

/**
 * Not `form_submit`, which Google Analytics 4 enhanced measurement sends for itself: a trigger on this name
 * would count a submission twice.
 */
const ANALYTICS_EVENT_NAME = 'form_submission'

/**
 * Pushes `{ event: 'form_submission', form_name }` to `window.dataLayer` each time a form carrying
 * `data-astro-form-analytics="<form name>"` is sent successfully, creating the array if the page has none. An
 * empty value is a markup mistake, so it warns and pushes nothing.
 */
export function attachFormAnalytics(formElement: HTMLFormElement, formController: FormPartHost): void {
  const formName = formElement.dataset.astroFormAnalytics
  if (formName === undefined) return

  if (formName.trim() === '') {
    console.warn(
      '[astro-form-submissions] data-astro-form-analytics is empty, so no analytics event is pushed; give it the form’s name',
      formElement
    )
    return
  }

  formElement.addEventListener(
    'astro-form:success',
    () => {
      const analyticsWindow = window as { dataLayer?: unknown[] }
      const dataLayer = (analyticsWindow.dataLayer ??= [])
      dataLayer.push({ event: ANALYTICS_EVENT_NAME, form_name: formName })
    },
    { signal: formController.signal }
  )
}

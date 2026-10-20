// MARK: - Configuration

/**
 * A refreshed Turnstile widget usually issues a new token within a second or two; past this, the
 * submission goes ahead and the server's verification error explains the failure.
 */
const TURNSTILE_TOKEN_TIMEOUT_MS = 30_000
const TURNSTILE_POLL_INTERVAL_MS = 100

/**
 * The loader is usually `async defer`, so it gets a moment to arrive. Past this, a container with no
 * rendered widget and no loader means the loader was blocked or omitted, and no token is coming.
 */
const TURNSTILE_LOADER_GRACE_MS = 2_000

// MARK: - Widget Refresh

/**
 * Best-effort refresh of this form's Turnstile widget (bare `turnstile.reset()` would reset every
 * widget on the page). The `turnstile` global is injected by the consuming page's widget loader;
 * it being absent or throwing must never affect form state.
 */
export function resetTurnstileWidget(formElement: HTMLFormElement): void {
  try {
    const turnstile = (window as { turnstile?: { reset(widgetElement?: string | Element | null): void } }).turnstile
    const widgetElement = formElement.querySelector('.cf-turnstile')
    if (widgetElement) turnstile?.reset(widgetElement)
  } catch (error) {
    console.warn('[astro-form-submissions] Failed to reset the Turnstile widget', error)
  }
}

// MARK: - Tokens

/** The hidden response inputs this form's Turnstile widgets render, whatever their `data-response-field-name`. */
function turnstileTokenInputs(formElement: HTMLFormElement): HTMLInputElement[] {
  return Array.from(formElement.querySelectorAll<HTMLInputElement>('.cf-turnstile input[type="hidden"]'))
}

/** Set the form's current Turnstile tokens on outgoing form data, replacing any captured before they were issued. */
export function applyTurnstileTokens(formElement: HTMLFormElement, formData: FormData): void {
  for (const tokenInputElement of turnstileTokenInputs(formElement)) {
    if (tokenInputElement.name) formData.set(tokenInputElement.name, tokenInputElement.value)
  }
}

/**
 * Resolves once every Turnstile widget in this form holds a token, or after
 * {@link TURNSTILE_TOKEN_TIMEOUT_MS}. Resolves at once for a form without a widget, and after
 * {@link TURNSTILE_LOADER_GRACE_MS} when no widget has rendered and the loader never arrived. Reads the
 * hidden response inputs the widgets render.
 */
export function waitForTurnstileToken(formElement: HTMLFormElement): Promise<void> {
  if (!formElement.querySelector('.cf-turnstile')) return Promise.resolve()

  const startedAt = Date.now()
  const deadline = startedAt + TURNSTILE_TOKEN_TIMEOUT_MS
  return new Promise((resolve) => {
    const poll = () => {
      const tokenInputElements = turnstileTokenInputs(formElement)
      const issued =
        tokenInputElements.length > 0 && tokenInputElements.every((tokenInputElement) => tokenInputElement.value !== '')
      const loaderMissing =
        tokenInputElements.length === 0 &&
        (window as { turnstile?: unknown }).turnstile === undefined &&
        Date.now() - startedAt >= TURNSTILE_LOADER_GRACE_MS
      if (issued || loaderMissing || Date.now() >= deadline) {
        resolve()
        return
      }

      setTimeout(poll, TURNSTILE_POLL_INTERVAL_MS)
    }
    poll()
  })
}

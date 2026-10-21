/**
 * Reveal the form's `[data-astro-form-requires-script]` elements, which a site renders `hidden` because they only
 * work with the script (a direct-upload field, say). Without the script they stay hidden and the rest of the form
 * posts as it always did.
 */
export function revealScriptOnlyParts(formElement: HTMLFormElement): void {
  for (const partElement of formElement.querySelectorAll<HTMLElement>('[data-astro-form-requires-script]')) {
    partElement.hidden = false
  }
}

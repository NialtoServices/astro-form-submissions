import { fillPlaceholders } from './placeholders.js'

/**
 * The copy for one message the script shows: the element's `data-astro-form-message-<name>` attribute when it
 * holds any text, otherwise `fallback`, with `{name}` tokens filled from `values` either way, so a site's own
 * wording can use the same placeholders as the default.
 *
 * @param element - The element carrying the site's copy, such as a file input.
 * @param name - The message's name in kebab case, such as `file-too-large`.
 * @param fallback - The default English copy.
 * @param values - What each placeholder stands for.
 * @returns The filled copy.
 */
export function message(
  element: Element,
  name: string,
  fallback: string,
  values: Readonly<Record<string, string>> = {}
): string {
  const siteCopy = element.getAttribute(`data-astro-form-message-${name}`)
  return fillPlaceholders(siteCopy?.trim() ? siteCopy : fallback, values)
}

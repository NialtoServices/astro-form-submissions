const PLACEHOLDER_PATTERN = /\{(\w+)\}/g

/**
 * Fills `{name}` tokens in copy from `values`. A token with no value of its own is left as written, so a
 * typo in a site's copy stays visible instead of vanishing, and a name like `{constructor}` never reaches
 * an inherited member.
 *
 * @param copy - The copy, with `{name}` tokens.
 * @param values - What each token stands for.
 * @returns The copy with every known token replaced.
 */
export function fillPlaceholders(copy: string, values: Readonly<Record<string, string>>): string {
  return copy.replace(PLACEHOLDER_PATTERN, (token, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined
    return value ?? token
  })
}

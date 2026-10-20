import type { EnrichmentResult } from '#enrichers/enricher.js'
import type { FormErrors } from '#errors.js'
import { jsonFormError } from '#responses.js'

/** What a person's browser receives for an enricher's refusal: the JSON body the route would answer with. */
export async function refusalBody(
  result: EnrichmentResult,
  errors?: FormErrors
): Promise<{ error: string; fieldErrors?: Record<string, string> }> {
  if (!('reject' in result)) throw new Error('expected a refusal')

  return (await jsonFormError(result.reject, errors).json()) as { error: string; fieldErrors?: Record<string, string> }
}

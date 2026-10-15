import type { VerdictDetails } from '#pipeline.js'

/** The verdicts a route reports: a refusal, a silent drop, or a quarantine. */
export type ReportedVerdictAction = 'reject' | 'drop' | 'quarantine'

/** Each reported action as the past-tense word a log line uses. */
export const VERDICT_PAST_TENSE: Record<ReportedVerdictAction, string> = {
  reject: 'rejected',
  drop: 'dropped',
  quarantine: 'quarantined'
}

/**
 * A guard, inspector, enricher or the route itself refused a submission (`reject`), silently stopped it
 * (`drop`), or withheld it from most destinations (`quarantine`). Reported to `onError` under the stage that
 * decided it, so an operator can tell one refusal from another. Carries the verdict's `code` and `details`;
 * the message names only the action and code, because a third-party stage's details are not guaranteed free
 * of submission data.
 */
export class SubmissionVerdictError extends Error {
  // MARK: - Object Lifecycle

  constructor(
    readonly action: ReportedVerdictAction,
    readonly code?: string,
    readonly details: VerdictDetails = {}
  ) {
    super(`The submission was ${VERDICT_PAST_TENSE[action]} (${code ?? 'no code given'}).`)
    this.name = 'SubmissionVerdictError'
  }
}

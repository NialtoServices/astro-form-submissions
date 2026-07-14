import { type FormError } from '#errors.js'

/**
 * A validated form submission. The toolkit assumes no fields of its own — each site's shape is inferred
 * from its `schema` (see {@link createFormRoute}); this is just the structural floor the stages share.
 */
export type FormSubmission = Record<string, unknown>

/**
 * What a guard or inspector decided:
 *
 * - `{ action: 'accept' }` — continue; on full acceptance the submission delivers to every dispatcher.
 * - `{ action: 'quarantine', reason? }` — the sender still sees success, but delivery is withheld from
 *   every dispatcher except those that opt in via `acceptsQuarantined` (e.g. an ops channel). The
 *   verdict is non-terminal, so later stages still run; an optional `reason` accumulates across stages.
 * - `{ action: 'drop' }` — silent stop; the sender sees success but nothing is delivered.
 * - `{ action: 'reject', error }` — hard stop; the sender sees the error's copy and status.
 */
export type Verdict =
  | { action: 'accept' }
  | { action: 'quarantine'; reason?: string }
  | { action: 'drop' }
  | { action: 'reject'; error: FormError }

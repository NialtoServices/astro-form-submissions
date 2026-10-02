/**
 * A required request-time value (a secret, variable or binding) is absent. Carries the missing `keys` and
 * names them in the message, but never a value, so it is safe to log in full.
 */
export class MissingEnvError extends Error {
  // MARK: - Object Lifecycle

  constructor(readonly keys: readonly string[]) {
    super(`Missing required environment ${keys.length === 1 ? 'value' : 'values'}: ${keys.join(', ')}`)
    this.name = 'MissingEnvError'
  }
}

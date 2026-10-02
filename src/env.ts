import { MissingEnvError } from '#missing-env-error.js'

/**
 * Reads the named values from a site's `env` (on Cloudflare, the `cloudflare:workers` binding), throwing one
 * {@link MissingEnvError} naming every key that is `undefined`, `null` or empty. Call it at the top of a
 * `defineLazyRoute` build, so a secret lost in a rotation or a new environment fails the build with its name
 * rather than surfacing as a provider's error, or as "verification failed" to the sender.
 *
 * The toolkit still reads no environment of its own: the site passes `env` in.
 */
export function requireEnv<Env extends object, const K extends keyof Env & string>(
  env: Env,
  keys: readonly K[]
): { [P in K]-?: Exclude<Env[P], undefined | null> } {
  const missing = keys.filter((key) => {
    const value: unknown = env[key]
    return value === undefined || value === null || value === ''
  })
  if (missing.length > 0) throw new MissingEnvError(missing)

  return Object.fromEntries(keys.map((key) => [key, env[key]])) as { [P in K]-?: Exclude<Env[P], undefined | null> }
}

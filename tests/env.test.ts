import { MissingEnvError, requireEnv } from '#env.js'
import { describe, expect, expectTypeOf, it } from 'vitest'

interface SiteEnv {
  POSTMARK_TOKEN?: string
  TURNSTILE_SECRET_KEY?: string
  DISCORD_WEBHOOK_URL?: string
  CONTACT_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> }
}

const limiter = { limit: async () => ({ success: true }) }

describe('requireEnv', () => {
  it('returns the requested values, typed as present', () => {
    const env: SiteEnv = { POSTMARK_TOKEN: 'pm-token', TURNSTILE_SECRET_KEY: 'ts-secret', CONTACT_LIMITER: limiter }

    const values = requireEnv(env, ['POSTMARK_TOKEN', 'CONTACT_LIMITER'])

    expect(values).toEqual({ POSTMARK_TOKEN: 'pm-token', CONTACT_LIMITER: limiter })
    expectTypeOf(values.POSTMARK_TOKEN).toEqualTypeOf<string>()
    expectTypeOf(values.CONTACT_LIMITER).toEqualTypeOf<NonNullable<SiteEnv['CONTACT_LIMITER']>>()
  })

  it('names every missing key, in the order requested, and no value', () => {
    const env: SiteEnv = { TURNSTILE_SECRET_KEY: 'ts-secret' }

    let thrown: unknown
    try {
      requireEnv(env, ['POSTMARK_TOKEN', 'TURNSTILE_SECRET_KEY', 'DISCORD_WEBHOOK_URL'])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(MissingEnvError)
    const error = thrown as MissingEnvError
    expect(error.name).toBe('MissingEnvError')
    expect(error.keys).toEqual(['POSTMARK_TOKEN', 'DISCORD_WEBHOOK_URL'])
    expect(error.message).toBe('Missing required environment values: POSTMARK_TOKEN, DISCORD_WEBHOOK_URL')
    expect(error.message).not.toContain('ts-secret')
  })

  it('uses the singular for one missing key', () => {
    expect(() => requireEnv({} as SiteEnv, ['POSTMARK_TOKEN'])).toThrow(
      'Missing required environment value: POSTMARK_TOKEN'
    )
  })

  it('treats an empty string and null as missing', () => {
    const env = { POSTMARK_TOKEN: '', TURNSTILE_SECRET_KEY: null } as unknown as SiteEnv

    expect(() => requireEnv(env, ['POSTMARK_TOKEN', 'TURNSTILE_SECRET_KEY'])).toThrow(
      'Missing required environment values: POSTMARK_TOKEN, TURNSTILE_SECRET_KEY'
    )
  })

  it('only accepts keys the env declares', () => {
    const env: SiteEnv = { POSTMARK_TOKEN: 'pm-token' }

    // @ts-expect-error `POSTMARK_TOKNE` is not a key of the env
    expect(() => requireEnv(env, ['POSTMARK_TOKNE'])).toThrow(MissingEnvError)
  })
})

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { DispatchContext, Dispatcher } from '#dispatchers/dispatcher.js'
import { formError } from '#errors.js'
import type { FormSubmission } from '#pipeline.js'
import { createFormRoute, defineLazyRoute, type FormRouteConfig } from '#route.js'
import { validationFailed } from '#schema.js'
import type { APIRoute } from 'astro'
import { describe, expect, it, vi } from 'vitest'
import { makeRouteContext } from './support/harness.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * A hand-rolled Standard Schema — the public interface the route consumes, so a stub is the
 * sanctioned seam (no Zod in unit tests). `validate` receives the toolkit's flattened, trimmed object.
 */
function standardSchema<Output>(
  validate: (
    value: Record<string, unknown>
  ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>
): StandardSchemaV1<Record<string, unknown>, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: validate as StandardSchemaV1.Props<Record<string, unknown>, Output>['validate']
    }
  }
}

interface ContactSubmission {
  name: string
  email: string
  message: string
}

/** The stand-in for a site's validator: name/email/message required, email format-checked. */
const contactSchema = standardSchema<ContactSubmission>((value) => {
  const issues: StandardSchemaV1.Issue[] = []
  for (const field of ['name', 'email', 'message'] as const) {
    if (typeof value[field] !== 'string') issues.push({ message: 'Please complete this field.', path: [field] })
  }
  if (typeof value.email === 'string' && !EMAIL_PATTERN.test(value.email)) {
    issues.push({ message: 'Please enter a valid email address.', path: ['email'] })
  }
  if (issues.length > 0) return { issues }
  return { value: { name: value.name, email: value.email, message: value.message } as ContactSubmission }
})

function contextFor(body: BodyInit, headers?: HeadersInit) {
  return makeRouteContext({ body, headers })
}

function validForm(overrides: Record<string, string> = {}) {
  const data = new FormData()
  data.set('name', 'Ada')
  data.set('email', 'ada@example.com')
  data.set('message', 'Hello there')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  return data
}

/** A controllable dispatcher stub whose dispatch calls are recorded with their context. */
function stubDispatcher(
  options: {
    acceptsQuarantined?: boolean
    required?: boolean
    exposesResources?: boolean
    deliverWhen?: (submission: FormSubmission, context: DispatchContext) => boolean
    failWith?: Error
  } = {}
) {
  const dispatch = vi.fn((_submission: FormSubmission, _context: DispatchContext) =>
    options.failWith ? Promise.reject(options.failWith) : Promise.resolve()
  )
  const dispatcher: Dispatcher = {
    acceptsQuarantined: options.acceptsQuarantined,
    required: options.required,
    exposesResources: options.exposesResources,
    deliverWhen: options.deliverWhen,
    dispatch
  }
  return { dispatcher, dispatch }
}

// `satisfies` (not an annotation) so the spread into `createFormRoute` doesn't carry a wide
// `enrichers` property type that would pollute the inferred enrichers tuple.
const baseConfig = {
  schema: contactSchema
} satisfies FormRouteConfig<typeof contactSchema>

/** Stands in for any inspector rejection — the route only sees the FormError value. */
const verificationError = formError('verification', 400, 'Verification failed. Please try again.')

describe('createFormRoute', () => {
  it('returns 200 and delivers to every dispatcher on a valid submission', async () => {
    const firstDispatcher = stubDispatcher()
    const secondDispatcher = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [firstDispatcher.dispatcher, secondDispatcher.dispatcher]
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(firstDispatcher.dispatch).toHaveBeenCalledOnce()
    expect(secondDispatcher.dispatch).toHaveBeenCalledOnce()
  })

  it('returns 200 with no inspectors or dispatchers configured', async () => {
    const response = await createFormRoute(baseConfig)(contextFor(validForm()))
    expect(response.status).toBe(200)
  })

  it('returns 400 invalidForm when the body is not form data', async () => {
    const response = await createFormRoute(baseConfig)(contextFor('{}', { 'content-type': 'application/json' }))
    expect(response.status).toBe(400)
  })

  it('refuses schema-invalid data with a summary and per-field messages keyed by field name', async () => {
    const response = await createFormRoute(baseConfig)(contextFor(new FormData()))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: validationFailed.message,
      fieldErrors: {
        name: 'Please complete this field.',
        email: 'Please complete this field.',
        message: 'Please complete this field.'
      }
    })
  })

  it('overrides the validation summary through the same errors map as everything else', async () => {
    const response = await createFormRoute({
      ...baseConfig,
      errors: { validationFailed: 'Please complete the name, email, and message fields.' }
    })(contextFor(new FormData()))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('Please complete the name, email, and message fields.')
  })

  it('an accepting inspector lets the submission continue to delivery', async () => {
    const { dispatcher, dispatch } = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'accept' as const }) }],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('rejecting inspector → its status and no dispatchers called', async () => {
    const { dispatcher, dispatch } = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'reject' as const, error: verificationError }) }],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))
    expect(response.status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("a rejection carries its error's status", async () => {
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        {
          inspect: async () => ({
            action: 'reject' as const,
            error: formError('rateLimited', 429, 'Too many attempts.')
          })
        }
      ]
    })(contextFor(validForm()))
    expect(response.status).toBe(429)
  })

  it('dropping inspector → silent 200, later inspectors skipped, no dispatchers called', async () => {
    const { dispatcher, dispatch } = stubDispatcher()
    const laterInspector = vi.fn()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'drop' as const }) }, { inspect: laterInspector }],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(laterInspector).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('quarantine reasons accumulate across inspectors and reach the dispatch context', async () => {
    const seen: DispatchContext[] = []
    const { dispatcher, dispatch } = stubDispatcher({ acceptsQuarantined: true })
    dispatch.mockImplementation(async (_submission, context) => {
      seen.push(context)
    })
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        { inspect: async () => ({ action: 'quarantine' as const, reason: 'casino' }) },
        { inspect: async () => ({ action: 'quarantine' as const, reason: 'crypto' }) }
      ],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(seen[0]!.quarantined).toBe(true)
    expect(seen[0]!.quarantineReasons).toEqual(['casino', 'crypto'])
  })

  it('a quarantine verdict routes only to acceptsQuarantined dispatchers, skipping the rest', async () => {
    const ops = stubDispatcher({ acceptsQuarantined: true })
    const customer = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'quarantine' as const, reason: 'spam' }) }],
      dispatchers: [customer.dispatcher, ops.dispatcher]
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(customer.dispatch).not.toHaveBeenCalled()
    expect(ops.dispatch).toHaveBeenCalledOnce()
  })

  it('a quarantined submission with no accepting dispatcher → silent 200 and one onError warning', async () => {
    const onError = vi.fn()
    const { dispatcher, dispatch } = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'quarantine' as const }) }],
      dispatchers: [dispatcher],
      onError
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(dispatch).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'unexpected' })
  })

  it('warns even with no dispatchers configured when a submission is quarantined', async () => {
    const onError = vi.fn()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'quarantine' as const }) }],
      onError
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'unexpected' })
  })

  it('a reject after a quarantine still rejects (terminal wins over the recorded quarantine)', async () => {
    const { dispatcher, dispatch } = stubDispatcher({ acceptsQuarantined: true })
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        { inspect: async () => ({ action: 'quarantine' as const, reason: 'spam' }) },
        { inspect: async () => ({ action: 'reject' as const, error: verificationError }) }
      ],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))
    expect(response.status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a drop after a quarantine still silently drops (honeypot stealth preserved)', async () => {
    const { dispatcher, dispatch } = stubDispatcher({ acceptsQuarantined: true })
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        { inspect: async () => ({ action: 'quarantine' as const, reason: 'spam' }) },
        { inspect: async () => ({ action: 'drop' as const }) }
      ],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a throwing inspector fails open and reports via onError', async () => {
    const onError = vi.fn()
    const { dispatcher, dispatch } = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        {
          inspect: async () => {
            throw new Error('flaky spam api')
          }
        }
      ],
      dispatchers: [dispatcher],
      onError
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'inspection' })
  })

  it('a required dispatcher failure → 502 and onError', async () => {
    const onError = vi.fn()
    const failing = stubDispatcher({ required: true, failWith: new Error('provider down') })
    const response = await createFormRoute({ ...baseConfig, dispatchers: [failing.dispatcher], onError })(
      contextFor(validForm())
    )
    expect(response.status).toBe(502)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'delivery' })
  })

  it('a non-required dispatcher failure → 200 and onError when another dispatcher delivered', async () => {
    const onError = vi.fn()
    const failing = stubDispatcher({ failWith: new Error('discord down') })
    const other = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [failing.dispatcher, other.dispatcher],
      onError
    })(contextFor(validForm()))
    expect(response.status).toBe(200)
    expect(other.dispatch).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'delivery' })
  })

  it('every attempted delivery failing → 502, even with no required dispatcher', async () => {
    const onError = vi.fn()
    const firstDispatcher = stubDispatcher({ failWith: new Error('discord down') })
    const secondDispatcher = stubDispatcher({ failWith: new Error('webhook revoked') })
    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [firstDispatcher.dispatcher, secondDispatcher.dispatcher],
      onError
    })(contextFor(validForm()))
    expect(response.status).toBe(502)
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('counts a resolved dispatch as a delivery — resolving means delivered, never an early return', async () => {
    // Per the contract, `dispatch` resolving means delivered; there is no "resolved but skipped" state,
    // so this dispatch counts and the sender sees success even though the sibling failed.
    const resolved = stubDispatcher()
    const failed = stubDispatcher({ failWith: new Error('discord down') })
    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [resolved.dispatcher, failed.dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(resolved.dispatch).toHaveBeenCalledOnce()
  })

  it('logs a PII-safe summary via console.error when no onError is supplied', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // The error message quotes submission-derived data that must not reach the default log.
      const failing = stubDispatcher({ failWith: new Error('SMTP rejected recipient ada@example.com') })
      const other = stubDispatcher()
      const response = await createFormRoute({ ...baseConfig, dispatchers: [failing.dispatcher, other.dispatcher] })(
        contextFor(validForm())
      )

      expect(response.status).toBe(200)
      expect(consoleSpy).toHaveBeenCalledWith('[astro-form-submissions] delivery error: Error')

      // Neither the message nor the raw Error object (which carries it) is logged.
      const logged = consoleSpy.mock.calls.flat().join(' ')
      expect(logged).not.toContain('ada@example.com')
      expect(consoleSpy.mock.calls.every((call) => call.every((argument) => typeof argument === 'string'))).toBe(true)
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('drops a free-text error code carrying submission data, but keeps a bounded machine code (PRV-001)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const piiCode = stubDispatcher({
        failWith: Object.assign(new Error('boom'), { code: 'recipient=ada@example.com' })
      })
      await createFormRoute({ ...baseConfig, dispatchers: [piiCode.dispatcher] })(contextFor(validForm()))
      const piiLog = consoleSpy.mock.calls.flat().join(' ')
      expect(piiLog).not.toContain('ada@example.com')
      expect(piiLog).not.toContain('code=')

      consoleSpy.mockClear()
      const machineCode = stubDispatcher({ failWith: Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }) })
      await createFormRoute({ ...baseConfig, dispatchers: [machineCode.dispatcher] })(contextFor(validForm()))
      expect(consoleSpy.mock.calls.flat().join(' ')).toContain('code=ETIMEDOUT')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('a synchronously throwing onError still yields the documented delivery failure response', async () => {
    const failing = stubDispatcher({ required: true, failWith: new Error('provider down') })
    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [failing.dispatcher],
      onError: () => {
        throw new Error('broken reporter')
      }
    })(contextFor(validForm()))
    expect(response.status).toBe(502)
  })

  it('a rejecting async onError is awaited and contained', async () => {
    const failing = stubDispatcher({ required: true, failWith: new Error('provider down') })
    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [failing.dispatcher],
      onError: async () => {
        throw new Error('broken async reporter')
      }
    })(contextFor(validForm()))
    expect(response.status).toBe(502)
  })

  it('a throwing onError during an unexpected failure still yields the 500 response', async () => {
    const response = await createFormRoute({
      schema: standardSchema(() => {
        throw new Error('schema blew up')
      }),
      onError: () => {
        throw new Error('broken reporter')
      }
    })(contextFor(validForm()))
    expect(response.status).toBe(500)
  })

  it('returns 500 unavailable and calls onError on an unexpected throw', async () => {
    const onError = vi.fn()
    const response = await createFormRoute({
      schema: standardSchema(() => {
        throw new Error('schema blew up')
      }),
      onError
    })(contextFor(validForm()))
    expect(response.status).toBe(500)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'unexpected' })
  })
})

describe('createFormRoute guards', () => {
  const requestTooLarge = formError('requestTooLarge', 413, 'Too large.')

  it('runs guards before the body is parsed', async () => {
    const validate = vi.fn(() => ({ value: {} }))
    const response = await createFormRoute({
      schema: standardSchema(validate),
      guards: [{ guard: async () => ({ action: 'reject' as const, error: requestTooLarge }) }]
    })(contextFor(validForm()))

    expect(response.status).toBe(413)
    expect(validate).not.toHaveBeenCalled()
  })

  it('a passing guard lets the request continue', async () => {
    const { dispatcher, dispatch } = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      guards: [{ guard: async () => ({ action: 'accept' as const }) }],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('a dropping guard returns a silent 200 and nothing runs', async () => {
    const validate = vi.fn(() => ({ value: {} }))
    const response = await createFormRoute({
      schema: standardSchema(validate),
      guards: [{ guard: async () => ({ action: 'drop' as const }) }]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(validate).not.toHaveBeenCalled()
  })

  it('a throwing guard fails open and reports via onError', async () => {
    const onError = vi.fn()
    const { dispatcher, dispatch } = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      guards: [
        {
          guard: async () => {
            throw new Error('flaky limiter')
          }
        }
      ],
      dispatchers: [dispatcher],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'guard' })
  })

  it('a guard can quarantine (recorded pre-body, applied at dispatch)', async () => {
    const ops = stubDispatcher({ acceptsQuarantined: true })
    const customer = stubDispatcher()

    const response = await createFormRoute({
      ...baseConfig,
      guards: [{ guard: async () => ({ action: 'quarantine' as const, reason: 'blocked-region' }) }],
      dispatchers: [customer.dispatcher, ops.dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(customer.dispatch).not.toHaveBeenCalled()
    // The guard's quarantine survives the body parse and reaches the dispatch gate, reason and all.
    expect(ops.dispatch).toHaveBeenCalledOnce()
    expect(ops.dispatch.mock.calls[0]![1].quarantineReasons).toEqual(['blocked-region'])
  })
})

describe('createFormRoute enrichers', () => {
  /** An enricher that provides a resource and records rollback invocations into `rolledBack`. */
  function stubEnricher(
    options: { provide?: Record<string, unknown>; reject?: ReturnType<typeof formError>; throws?: boolean } = {}
  ) {
    const rolledBack: string[] = []
    const label = options.reject?.key ?? 'ok'
    const enricher = {
      enrich: vi.fn(async () => {
        if (options.throws) throw new Error('enricher blew up')
        if (options.reject) return { reject: options.reject }
        return { provide: options.provide, rollback: async () => void rolledBack.push(label) }
      })
    }
    return { enricher, rolledBack, label }
  }

  it('exposes an enricher-provided resource on the dispatch context, leaving the submission untouched', async () => {
    const seenSubmissions: FormSubmission[] = []
    const seenResources: unknown[] = []
    const { dispatcher, dispatch } = stubDispatcher()
    dispatch.mockImplementation(async (submission, context) => {
      seenSubmissions.push(submission)
      seenResources.push(context.resources)
    })
    const { enricher } = stubEnricher({ provide: { files: [{ name: 'a.pdf', url: 'https://x/a/' }] } })

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [enricher],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(seenResources[0]).toMatchObject({ files: [{ name: 'a.pdf', url: 'https://x/a/' }] })

    // The submission stays exactly the schema's validated input — the resource is not merged onto it.
    expect(seenSubmissions[0]).not.toHaveProperty('files')
  })

  it('a rejecting enricher fails with its error, rolls back prior enrichers, and skips delivery', async () => {
    const first = stubEnricher({ provide: { files: [] } })
    const rejecting = stubEnricher({ reject: formError('fileTooLarge', 400, 'Too big.') })
    const { dispatcher, dispatch } = stubDispatcher()

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [first.enricher, rejecting.enricher],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(400)
    expect(first.rolledBack).toEqual(['ok'])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a throwing enricher fails closed (500), rolls back, and reports via onError', async () => {
    const onError = vi.fn()
    const first = stubEnricher({ provide: {} })
    const throwing = stubEnricher({ throws: true })

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [first.enricher, throwing.enricher],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(500)
    expect(first.rolledBack).toEqual(['ok'])
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'enrichment' })
  })

  it('rolls back a prior enricher when a later result throws during interpretation (RES-001)', async () => {
    const onError = vi.fn()
    const first = stubEnricher({ provide: { files: [] } })
    // A hostile result whose `provide` getter throws while the route reads it — this interpretation runs
    // outside `enrich()`, so it must still be inside the enrichment boundary that rolls prior work back.
    const hostile = {
      enrich: async () => ({
        get provide(): Record<string, unknown> {
          throw new Error('provide getter blew up')
        }
      })
    }

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [first.enricher, hostile],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(500)
    expect(first.rolledBack).toEqual(['ok'])
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'enrichment' })
  })

  it('rolls back in reverse order', async () => {
    const shared: string[] = []
    const enricherFor = (name: string) => ({
      enrich: async () => ({ rollback: async () => void shared.push(name) })
    })
    const rejecting = { enrich: async () => ({ reject: formError('fileType', 400, 'No.') }) }

    await createFormRoute({
      ...baseConfig,
      enrichers: [enricherFor('first'), enricherFor('second'), rejecting]
    })(contextFor(validForm()))

    expect(shared).toEqual(['second', 'first'])
  })

  it('rolls back when a required dispatcher fails after enrichment', async () => {
    const { enricher, rolledBack } = stubEnricher({ provide: { files: [] } })
    const failing = stubDispatcher({ required: true, failWith: new Error('provider down') })

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [enricher],
      dispatchers: [failing.dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(502)
    expect(rolledBack).toEqual(['ok'])
  })

  it('does not roll back on a fully successful submission', async () => {
    const { enricher, rolledBack } = stubEnricher({ provide: { files: [] } })
    const { dispatcher } = stubDispatcher()

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [enricher],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(rolledBack).toEqual([])
  })

  it('ignores a prototype-polluting provided key', async () => {
    const seen: unknown[] = []
    const { dispatcher, dispatch } = stubDispatcher()
    dispatch.mockImplementation(async (_submission, context) => void seen.push(context.resources))
    const enricher = {
      enrich: async () => ({
        provide: JSON.parse('{"__proto__":{"polluted":true},"kept":1}') as Record<string, unknown>
      })
    }

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [enricher],
      dispatchers: [dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect((seen[0] as Record<string, unknown>).kept).toBe(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rolls back and still returns 200 when a quarantine skips the only dispatcher (nothing exposed the links)', async () => {
    const { enricher, rolledBack } = stubEnricher({ provide: { files: [] } })
    const skipped = stubDispatcher()

    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'quarantine' as const }) }],
      enrichers: [enricher],
      dispatchers: [skipped.dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(skipped.dispatch).not.toHaveBeenCalled()
    expect(rolledBack).toEqual(['ok'])
  })

  it('does NOT roll back when a dispatcher already delivered, even if a required sibling fails', async () => {
    const { enricher, rolledBack } = stubEnricher({ provide: { files: [] } })
    const delivered = stubDispatcher()
    const failedRequired = stubDispatcher({ required: true, failWith: new Error('discord down') })

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [enricher],
      dispatchers: [delivered.dispatcher, failedRequired.dispatcher]
    })(contextFor(validForm()))

    // 502 for retry, but the delivered dispatcher exposes the resources by default (it could have
    // carried the links), so they're kept rather than deleted out from under a delivered recipient.
    expect(response.status).toBe(502)
    expect(delivered.dispatch).toHaveBeenCalledOnce()
    expect(rolledBack).toEqual([])
  })

  it('rolls back when only a non-exposing delivery succeeded and the resource-bearing one failed', async () => {
    const { enricher, rolledBack } = stubEnricher({ provide: { files: [] } })
    const notification = stubDispatcher({ exposesResources: false })
    const email = stubDispatcher({ required: true, exposesResources: true, failWith: new Error('smtp down') })

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [enricher],
      dispatchers: [notification.dispatcher, email.dispatcher]
    })(contextFor(validForm()))

    // The notification succeeded but carries no links; the email that would have failed, so the files
    // reached no recipient and must be rolled back rather than orphaned for a retry to duplicate.
    expect(response.status).toBe(502)
    expect(notification.dispatch).toHaveBeenCalledOnce()
    expect(rolledBack).toEqual(['ok'])
  })

  it('reports a failed rollback without masking the original failure or skipping the others', async () => {
    const onError = vi.fn()
    const cleaned: string[] = []
    const okRollback = { enrich: async () => ({ rollback: async () => void cleaned.push('ok') }) }
    const throwingRollback = {
      enrich: async () => ({
        rollback: async () => {
          throw new Error('delete failed')
        }
      })
    }
    const failing = stubDispatcher({ required: true, failWith: new Error('provider down') })

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [okRollback, throwingRollback],
      dispatchers: [failing.dispatcher],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(502)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'enrichment' })
    // Rollbacks run in reverse, so the throwing one runs first; the other must still complete.
    expect(cleaned).toEqual(['ok'])
  })
})

describe('createFormRoute report draining', () => {
  it('awaits an async onError triggered via an inspector report before responding', async () => {
    let settled = false
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        {
          inspect: async (inspectionContext) => {
            inspectionContext.report?.(new Error('upstream outage'))
            return { action: 'accept' as const }
          }
        }
      ],
      onError: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        settled = true
      }
    })(contextFor(validForm()))

    // The response is only returned after the detached report promise has settled.
    expect(response.status).toBe(200)
    expect(settled).toBe(true)
  })
})

describe('createFormRoute responses', () => {
  it('reports success as { ok: true }', async () => {
    const response = await createFormRoute(baseConfig)(contextFor(validForm()))
    expect(await response.json()).toEqual({ ok: true })
  })

  it('reports a keyed failure with its user-facing copy', async () => {
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'reject' as const, error: verificationError }) }]
    })(contextFor(validForm()))
    expect(await response.json()).toEqual({ error: verificationError.message })
  })

  it('uses overridden error copy in the body', async () => {
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'reject' as const, error: verificationError }) }],
      errors: { verification: 'Please prove you are human.' }
    })(contextFor(validForm()))
    expect(await response.json()).toEqual({ error: 'Please prove you are human.' })
  })

  it('contains a throwing copy resolver and still returns the keyed failure with default copy', async () => {
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'reject' as const, error: verificationError }) }],
      errors: () => {
        throw new Error('broken i18n hook')
      }
    })(contextFor(validForm()))

    // The resolver throws while the failure response is built; it must not reject the request.
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: verificationError.message })
  })
})

describe('createFormRoute inspector contract', () => {
  it('hands inspectors the built submission, raw form data, request/site URLs, and client address', async () => {
    const seen: {
      submission?: FormSubmission
      token?: string
      requestURL?: string
      siteURL?: string
      clientAddress?: string
    } = {}
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        {
          inspect: async (inspectionContext) => {
            seen.submission = inspectionContext.submission
            seen.token = String(inspectionContext.data.get('cf-turnstile-response'))
            seen.requestURL = inspectionContext.requestURL.href
            seen.siteURL = inspectionContext.siteURL?.href
            seen.clientAddress = inspectionContext.clientAddress
            return { action: 'accept' as const }
          }
        }
      ]
    })(contextFor(validForm({ 'cf-turnstile-response': 'token-123' })))

    expect(response.status).toBe(200)
    expect(seen.submission).toMatchObject({ name: 'Ada', email: 'ada@example.com' })
    expect(seen.submission).not.toHaveProperty('siteHost')
    expect(seen.token).toBe('token-123')
    expect(seen.requestURL).toBe('https://example.com/api/form')
    expect(seen.siteURL).toBe('https://example.com/')
    expect(seen.clientAddress).toBe('1.2.3.4')
  })

  it('exposes a contained report channel that feeds onError without changing the verdict', async () => {
    const onError = vi.fn()
    const { dispatcher, dispatch } = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        {
          inspect: async (inspectionContext) => {
            inspectionContext.report?.(new Error('upstream outage'))
            return { action: 'accept' as const }
          }
        }
      ],
      dispatchers: [dispatcher],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'inspection' })
  })

  it('a throwing onError behind the report channel still cannot affect the response', async () => {
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        {
          inspect: async (inspectionContext) => {
            inspectionContext.report?.(new Error('upstream outage'))
            return { action: 'accept' as const }
          }
        }
      ],
      onError: () => {
        throw new Error('broken reporter')
      }
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
  })

  it('still succeeds and hands inspectors no client address when the runtime cannot resolve one', async () => {
    // Astro's `clientAddress` getter throws in prerendered/static contexts; the route must
    // neither crash nor silently skip the inspector (which would bypass verification).
    const url = new URL('https://example.com/api/form')
    const context = {
      request: new Request(url, { method: 'POST', body: validForm() }),
      site: new URL('https://example.com'),
      url,
      locals: {},
      get clientAddress(): string {
        throw new Error('clientAddress is not available in prerendered pages')
      }
    } as unknown as Parameters<APIRoute>[0]

    let seenAddress: string | undefined = 'unset'
    const inspect = vi.fn(async (inspectionContext: { clientAddress?: string }) => {
      seenAddress = inspectionContext.clientAddress
      return { action: 'accept' as const }
    })
    const response = await createFormRoute({ ...baseConfig, inspectors: [{ inspect }] })(context)

    expect(response.status).toBe(200)
    expect(inspect).toHaveBeenCalledOnce()
    expect(seenAddress).toBeUndefined()
  })

  it('a rejecting inspector prevents later inspectors from running', async () => {
    const laterInspector = vi.fn()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        { inspect: async () => ({ action: 'reject' as const, error: verificationError }) },
        { inspect: laterInspector }
      ]
    })(contextFor(validForm()))

    expect(response.status).toBe(400)
    expect(laterInspector).not.toHaveBeenCalled()
  })
})

describe('createFormRoute schema stage', () => {
  it('hands the stages the validated output verbatim, with no siteHost merged in', async () => {
    const seen: FormSubmission[] = []
    const { dispatcher, dispatch } = stubDispatcher()
    dispatch.mockImplementation(async (submission) => void seen.push(submission))

    const response = await createFormRoute({ schema: contactSchema, dispatchers: [dispatcher] })(
      contextFor(validForm())
    )

    expect(response.status).toBe(200)
    expect(seen[0]).toEqual({ name: 'Ada', email: 'ada@example.com', message: 'Hello there' })
    expect(seen[0]).not.toHaveProperty('siteHost')
  })

  it('awaits an async validator before continuing', async () => {
    const { dispatcher, dispatch } = stubDispatcher()
    const asyncSchema = standardSchema<ContactSubmission>(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { value: value as unknown as ContactSubmission }
    })

    const response = await createFormRoute({ schema: asyncSchema, dispatchers: [dispatcher] })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it.each([
    ['a string', 'just a string'],
    ['an array', ['not', 'a', 'record']],
    ['null', null]
  ])('rejects a schema that outputs %s → 500 unavailable, one onError, no dispatch', async (_label, output) => {
    const onError = vi.fn()
    const { dispatcher, dispatch } = stubDispatcher()
    const scalarSchema = standardSchema<unknown>(() => ({ value: output }))

    const response = await createFormRoute({ schema: scalarSchema, dispatchers: [dispatcher], onError })(
      contextFor(validForm())
    )

    expect(response.status).toBe(500)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'unexpected' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('validates the trimmed single-valued text fields and omits file uploads', async () => {
    let received: Record<string, unknown> | undefined
    const recordingSchema = standardSchema<Record<string, unknown>>((value) => {
      received = value
      return { value }
    })

    const data = validForm({ name: '  Ada  ' })
    data.set('attachment', new File(['pdf-bytes'], 'cv.pdf', { type: 'application/pdf' }))
    await createFormRoute({ schema: recordingSchema })(contextFor(data))

    expect(received).toMatchObject({ name: 'Ada', email: 'ada@example.com' })
    expect(received).not.toHaveProperty('attachment')
  })

  it('uses the generic summary even for a single issue, with the message in fieldErrors', async () => {
    const oneIssue = standardSchema(() => ({ issues: [{ message: 'Enter a valid email.', path: ['email'] }] }))
    const response = await createFormRoute({ schema: oneIssue })(contextFor(validForm()))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: validationFailed.message,
      fieldErrors: { email: 'Enter a valid email.' }
    })
  })

  it('a lone path-less issue yields only the generic summary and no fieldErrors', async () => {
    const pathless = standardSchema(() => ({ issues: [{ message: 'This form could not be read.' }] }))
    const response = await createFormRoute({ schema: pathless })(contextFor(validForm()))

    expect(await response.json()).toEqual({ error: validationFailed.message })
  })

  it('fails closed on an empty issues array (a failure result carries issues, so it is never success)', async () => {
    const { dispatcher, dispatch } = stubDispatcher()
    const emptyIssues = standardSchema(() => ({ issues: [] }) as never)
    const response = await createFormRoute({ schema: emptyIssues, dispatchers: [dispatcher] })(contextFor(validForm()))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: validationFailed.message })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects a non-conformant result carrying neither issues nor value', async () => {
    const { dispatcher, dispatch } = stubDispatcher()
    const neither = standardSchema(() => ({}) as never)
    const response = await createFormRoute({ schema: neither, dispatchers: [dispatcher] })(contextFor(validForm()))

    expect(response.status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('multiple issues use the validationFailed summary and drop path-less issues from fieldErrors', async () => {
    const many = standardSchema(() => ({
      issues: [{ message: 'Enter a valid email.', path: ['email'] }, { message: 'A cross-field rule failed.' }]
    }))
    const response = await createFormRoute({ schema: many })(contextFor(validForm()))

    expect(await response.json()).toEqual({
      error: validationFailed.message,
      fieldErrors: { email: 'Enter a valid email.' }
    })
  })

  it('keeps the first issue per field when a field fails more than once', async () => {
    const repeated = standardSchema(() => ({
      issues: [
        { message: 'Required.', path: ['email'] },
        { message: 'Also not an email.', path: ['email'] }
      ]
    }))
    const response = await createFormRoute({ schema: repeated })(contextFor(validForm()))

    expect((await response.json()).fieldErrors).toEqual({ email: 'Required.' })
  })

  it('a schema factory builds a request-specific validator (the i18n hook)', async () => {
    const localized = (message: string) => standardSchema(() => ({ issues: [{ message, path: ['email'] }] }))
    const response = await createFormRoute({
      schema: ({ data }) =>
        data.get('lang') === 'fr' ? localized('Saisissez un e-mail valide.') : localized('Enter a valid email.')
    })(contextFor(validForm({ lang: 'fr' })))

    // The generic summary is unchanged; the request-specific localization surfaces in the field message.
    expect(await response.json()).toEqual({
      error: validationFailed.message,
      fieldErrors: { email: 'Saisissez un e-mail valide.' }
    })
  })

  it('reshapes the output via a transform yet attributes issues to the pre-transform field', async () => {
    const seen: FormSubmission[] = []
    const { dispatcher, dispatch } = stubDispatcher()
    dispatch.mockImplementation(async (submission) => void seen.push(submission))
    const splitName = standardSchema<{ name: string }>((value) => {
      if (typeof value.first_name !== 'string')
        return { issues: [{ message: 'First name is required.', path: ['first_name'] }] }
      return { value: { name: `${String(value.first_name)} ${String(value.last_name)}` } }
    })

    const ok = await createFormRoute({ schema: splitName, dispatchers: [dispatcher] })(
      contextFor(validForm({ first_name: 'Ada', last_name: 'Lovelace' }))
    )
    expect(ok.status).toBe(200)
    expect(seen[0]).toEqual({ name: 'Ada Lovelace' })
    expect(seen[0]).not.toHaveProperty('first_name')

    const bad = await createFormRoute({ schema: splitName })(contextFor(new FormData()))
    expect((await bad.json()).fieldErrors).toEqual({ first_name: 'First name is required.' })
  })
})

describe('createFormRoute failClosed', () => {
  it('a throwing guard with failClosed fails the request 500 and reports it', async () => {
    const onError = vi.fn()
    const response = await createFormRoute({
      ...baseConfig,
      guards: [
        {
          failClosed: true,
          guard: async () => {
            throw new Error('origin lookup exploded')
          }
        }
      ],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(500)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'guard' })
  })

  it('a throwing inspector with failClosed fails the request 500 and reports it', async () => {
    const onError = vi.fn()
    const { dispatcher, dispatch } = stubDispatcher()
    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [
        {
          failClosed: true,
          inspect: async () => {
            throw new Error('security check exploded')
          }
        }
      ],
      dispatchers: [dispatcher],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(500)
    expect(dispatch).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'inspection' })
  })
})

describe('defineLazyRoute', () => {
  it('builds the route on first request and reuses it for later ones', async () => {
    const inner = vi.fn<APIRoute>(async () => new Response('ok'))
    const build = vi.fn(() => inner)
    const route = defineLazyRoute(build)

    await route(contextFor(validForm()))
    await route(contextFor(validForm()))
    await route(contextFor(validForm()))

    expect(build).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(3)
  })

  it('shares one build across concurrent first requests', async () => {
    let resolveBuild!: (route: APIRoute) => void
    const buildPromise = new Promise<APIRoute>((resolve) => {
      resolveBuild = resolve
    })
    const build = vi.fn(() => buildPromise)
    const route = defineLazyRoute(build)

    const inFlight = [route(contextFor(validForm())), route(contextFor(validForm()))]
    resolveBuild(async () => new Response('ok'))
    await Promise.all(inFlight)

    expect(build).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed build — the next request retries', async () => {
    const inner = vi.fn<APIRoute>(async () => new Response('ok'))
    const build = vi
      .fn<() => APIRoute>()
      .mockImplementationOnce(() => {
        throw new Error('env not ready')
      })
      .mockImplementation(() => inner)
    const route = defineLazyRoute(build)

    await expect(route(contextFor(validForm()))).rejects.toThrow('env not ready')

    const response = await route(contextFor(validForm()))
    expect(await response.text()).toBe('ok')
    expect(build).toHaveBeenCalledTimes(2)
  })
})

describe('createFormRoute deliverWhen', () => {
  it('skips a dispatcher whose deliverWhen returns false, delivering to the rest', async () => {
    const delivered = stubDispatcher()
    const skipped = stubDispatcher({ deliverWhen: () => false })

    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [delivered.dispatcher, skipped.dispatcher]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(delivered.dispatch).toHaveBeenCalledOnce()
    expect(skipped.dispatch).not.toHaveBeenCalled()
  })

  it('delivers when deliverWhen returns true', async () => {
    const { dispatcher, dispatch } = stubDispatcher({ deliverWhen: () => true })

    const response = await createFormRoute({ ...baseConfig, dispatchers: [dispatcher] })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('a skip is not counted as a delivery — a failing sibling with no success still 502s', async () => {
    const failing = stubDispatcher({ failWith: new Error('provider down') })
    const skipped = stubDispatcher({ deliverWhen: () => false })

    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [failing.dispatcher, skipped.dispatcher]
    })(contextFor(validForm()))

    // The skip must not stand in for a success — every *attempted* delivery failed.
    expect(response.status).toBe(502)
    expect(skipped.dispatch).not.toHaveBeenCalled()
  })

  it('a throwing deliverWhen is a delivery failure (reported), not an uncaught rejection', async () => {
    const onError = vi.fn()
    const { dispatcher, dispatch } = stubDispatcher({
      required: true,
      deliverWhen: () => {
        throw new Error('predicate boom')
      }
    })

    const response = await createFormRoute({ ...baseConfig, dispatchers: [dispatcher], onError })(
      contextFor(validForm())
    )

    expect(response.status).toBe(502)
    expect(dispatch).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'delivery' })
  })
})

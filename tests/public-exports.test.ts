import * as toolkit from '#index.js'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('package entry', () => {
  it('exports every error a dispatcher can hand to onError, and the default reporter', () => {
    expect(toolkit).toMatchObject({
      DestinationUnreachableError: expect.any(Function),
      DiscordDeliveryError: expect.any(Function),
      EmailRecipientError: expect.any(Function),
      PostmarkDeliveryError: expect.any(Function),
      defaultErrorReporter: expect.any(Function)
    })
  })

  it('names one reporter type that serves the route and the lazy build alike', () => {
    expectTypeOf<toolkit.LazyRouteOptions['onError']>().toEqualTypeOf<toolkit.ErrorReporter | undefined>()
    expectTypeOf<NonNullable<toolkit.FormRouteConfig<never>['onError']>>().toEqualTypeOf<toolkit.ErrorReporter>()
  })
})

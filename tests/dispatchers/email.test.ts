import { EmailRecipientError } from '#dispatchers/email-recipient-error.js'
import { EmailDispatcher, renderEmail, type EmailTemplates } from '#dispatchers/email.js'
import { submissionNotificationTemplates } from '#dispatchers/submission-notification.js'
import { describe, expect, it, vi } from 'vitest'
import { dispatchContext } from '../dispatch-context.js'
import { deliveredMessage } from '../support/harness.js'

const templates: EmailTemplates = {
  subject: (submission) => `Enquiry from ${submission.name}`,
  text: () => 'text body',
  html: () => '<p>html body</p>'
}

function dispatcherWith(deliver = vi.fn(), options: { required?: boolean } = {}) {
  return new EmailDispatcher({
    transport: { deliver },
    templates,
    from: 'from@example.com',
    to: 'to@example.com',
    replyTo: (submission) => submission.email as string | undefined,
    ...options
  })
}

describe('EmailDispatcher', () => {
  it('renders the templates and hands the transport a complete message', async () => {
    const deliver = vi.fn()
    await dispatcherWith(deliver).dispatch({ name: 'Ada', email: 'ada@example.com' }, dispatchContext())

    expect(deliver).toHaveBeenCalledOnce()
    const message = deliveredMessage(deliver)
    expect(message).toEqual({
      from: 'from@example.com',
      to: 'to@example.com',
      replyTo: 'ada@example.com',
      subject: 'Enquiry from Ada',
      text: 'text body',
      html: '<p>html body</p>'
    })
  })

  it('resolves function `from`/`to` against the submission (e.g. to acknowledge the sender)', async () => {
    const deliver = vi.fn()
    const dispatcher = new EmailDispatcher({
      transport: { deliver },
      templates,
      from: () => 'noreply@acme.test',
      to: (submission) => submission.email as string
    })
    await dispatcher.dispatch({ name: 'Ada', email: 'ada@example.com' }, dispatchContext())

    const message = deliveredMessage(deliver)
    expect(message.from).toBe('noreply@acme.test')
    expect(message.to).toBe('ada@example.com')
  })

  it('resolves replyTo (fixed or per-submission) and omits the header when it resolves empty', async () => {
    const resolved = vi.fn()
    await new EmailDispatcher({
      transport: { deliver: resolved },
      templates,
      from: 'f@x',
      to: 't@x',
      replyTo: (submission) => submission.email as string | undefined
    }).dispatch({ email: 'ada@example.com' }, dispatchContext())
    expect(deliveredMessage(resolved).replyTo).toBe('ada@example.com')

    const omitted = vi.fn()
    await new EmailDispatcher({
      transport: { deliver: omitted },
      templates,
      from: 'f@x',
      to: 't@x',
      replyTo: () => undefined
    }).dispatch({ email: 'ada@example.com' }, dispatchContext())
    expect(deliveredMessage(omitted)).not.toHaveProperty('replyTo')
  })

  it('threads the quarantine disposition into the templates (parity with Discord)', async () => {
    const deliver = vi.fn()
    const dispositionTemplates: EmailTemplates = {
      subject: (_submission, context) =>
        context.quarantined ? `Blocked (${context.quarantineReasons.join(', ')})` : 'New enquiry',
      text: () => 'text body',
      html: () => '<p>html body</p>'
    }
    const dispatcher = new EmailDispatcher({
      transport: { deliver },
      templates: dispositionTemplates,
      from: 'f@x',
      to: 't@x'
    })
    await dispatcher.dispatch({ name: 'Ada' }, dispatchContext({ quarantined: true, quarantineReasons: ['casino'] }))

    expect(deliveredMessage(deliver).subject).toBe('Blocked (casino)')
  })

  it('defaults acceptsQuarantined to false, opting in only when set', () => {
    expect(dispatcherWith().acceptsQuarantined).toBe(false)
    const optedIn = new EmailDispatcher({
      transport: { deliver: vi.fn() },
      templates,
      from: 'f@x',
      to: 't@x',
      acceptsQuarantined: true
    })
    expect(optedIn.acceptsQuarantined).toBe(true)
  })

  it('is required by default', () => {
    expect(dispatcherWith().required).toBe(true)
    expect(dispatcherWith(vi.fn(), { required: false }).required).toBe(false)
  })

  it.each([
    'ada@example.com, eve@example.com',
    'ada@example.com;eve@example.com',
    'ada@example.com\r\nBcc: eve@example.com',
    '"Ada" <ada@example.com>, eve@example.com',
    '"Lovelace, Ada <ada@example.com>, eve@example.com',
    '"Ada\r\nBcc: eve@example.com" <ada@example.com>',
    'ada@example.com eve@example.com',
    'Ada <ada@example.com> <eve@example.com>',
    'ada@example.com\u0085X-Priority: 1'
  ])('refuses a `to` function that resolves to several addresses or a header break (%j)', async (address) => {
    const deliver = vi.fn()
    const dispatcher = new EmailDispatcher({
      transport: { deliver },
      templates,
      from: 'noreply@acme.test',
      to: (submission) => submission.email as string
    })

    await expect(dispatcher.dispatch({ email: address }, dispatchContext())).rejects.toBeInstanceOf(EmailRecipientError)
    expect(deliver).not.toHaveBeenCalled()
  })

  it.each([
    'ada@example.com, eve@example.com',
    'ada@example.com\nBcc: eve@example.com',
    'ada@example.com eve@example.com',
    'ada@example.com\u0085X-Priority: 1'
  ])('refuses a `replyTo` function that resolves to several addresses or a header break (%j)', async (address) => {
    const deliver = vi.fn()
    const dispatcher = new EmailDispatcher({
      transport: { deliver },
      templates,
      from: 'noreply@acme.test',
      to: 'owner@acme.test',
      replyTo: (submission) => submission.email as string
    })

    await expect(dispatcher.dispatch({ email: address }, dispatchContext())).rejects.toMatchObject({
      name: 'EmailRecipientError',
      field: 'replyTo'
    })
    expect(deliver).not.toHaveBeenCalled()
  })

  it.each([
    '"Lovelace, Ada" <ada@example.com>',
    '"Ada; Byron" <ada@example.com>',
    '"Ada \\"A, L\\"" <ada@example.com>',
    '"ada@home" <ada@example.com>'
  ])('accepts a comma, semicolon or @ inside a quoted display name (%j)', async (address) => {
    const deliver = vi.fn()
    await new EmailDispatcher({
      transport: { deliver },
      templates,
      from: 'noreply@acme.test',
      to: (submission) => submission.email as string,
      replyTo: (submission) => submission.email as string
    }).dispatch({ email: address }, dispatchContext())

    expect(deliveredMessage(deliver)).toMatchObject({ to: address, replyTo: address })
  })

  it('turns control characters in a resolved `from` into spaces', async () => {
    const deliver = vi.fn()
    await new EmailDispatcher({
      transport: { deliver },
      templates,
      from: (submission) => `${submission.name as string} via Example <forms@example.com>`,
      to: 'owner@acme.test'
    }).dispatch({ name: 'Ada\r\n\u0085Bcc: eve@example.org' }, dispatchContext())

    expect(deliveredMessage(deliver).from).toBe('Ada Bcc: eve@example.org via Example <forms@example.com>')
  })

  it.each(['\r\n', '\u0085', '\u0000\u009b'])(
    'turns control characters in a rendered subject into spaces (%j)',
    (breaker) => {
      const content = renderEmail(
        { subject: () => `Thanks Ada${breaker}Bcc: eve@example.com`, text: () => '', html: () => '' },
        {},
        dispatchContext()
      )

      expect(content.subject).toBe('Thanks Ada Bcc: eve@example.com')
    }
  )

  it('keeps the address out of the recipient error', () => {
    expect(new EmailRecipientError().message).not.toContain('@')
  })

  it('lets a fixed `to` string list several of the site’s own inboxes', async () => {
    const deliver = vi.fn()
    await new EmailDispatcher({
      transport: { deliver },
      templates,
      from: 'noreply@acme.test',
      to: 'owner@acme.test, office@acme.test'
    }).dispatch({ name: 'Ada' }, dispatchContext())

    expect(deliveredMessage(deliver).to).toBe('owner@acme.test, office@acme.test')
  })

  it('propagates a transport failure', async () => {
    const deliver = vi.fn(() => Promise.reject(new Error('provider down')))
    await expect(dispatcherWith(deliver).dispatch({ name: 'Ada' }, dispatchContext())).rejects.toThrow('provider down')
  })

  describe('exposesResources default derivation', () => {
    function dispatcherFor<E extends Record<string, unknown>, A>(
      chosenTemplates: EmailTemplates<E, A>,
      exposesResources?: boolean
    ) {
      return new EmailDispatcher<E, A>({
        transport: { deliver: vi.fn() },
        templates: chosenTemplates,
        from: 'f@x',
        to: 't@x',
        exposesResources
      })
    }

    it('defaults from the built-in template marker — true when it renders attachments', () => {
      const withAttachments = submissionNotificationTemplates<{ name: string }, 'files'>({
        fields: ['name'],
        attachments: 'files'
      })
      expect(dispatcherFor(withAttachments).exposesResources).toBe(true)
    })

    it('defaults from the built-in template marker — false when it renders no attachments', () => {
      const withoutAttachments = submissionNotificationTemplates<{ name: string }>({ fields: ['name'] })
      expect(dispatcherFor(withoutAttachments).exposesResources).toBe(false)
    })

    it('lets an explicit constructor option override the template marker', () => {
      const withoutAttachments = submissionNotificationTemplates<{ name: string }>({ fields: ['name'] })
      expect(dispatcherFor(withoutAttachments, true).exposesResources).toBe(true)

      const withAttachments = submissionNotificationTemplates<{ name: string }, 'files'>({
        fields: ['name'],
        attachments: 'files'
      })
      expect(dispatcherFor(withAttachments, false).exposesResources).toBe(false)
    })

    it('defaults to true for hand-written templates that carry no marker', () => {
      expect(dispatcherFor(templates).exposesResources).toBe(true)
    })
  })
})

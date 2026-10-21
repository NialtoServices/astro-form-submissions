import { EmailRecipientError } from '#dispatchers/email-recipient-error.js'
import { EmailDispatcher, renderEmail, type EmailTemplates } from '#dispatchers/email.js'
import { submissionNotificationTemplates } from '#dispatchers/submission-notification.js'
import { FileAttachments } from '#enrichers/file-attachments.js'
import { OperationalError } from '#operational-error.js'
import emailAddresses from 'email-addresses'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { dispatchContext } from '../dispatch-context.js'
import { addressLike, displayName, textWithControlCharacter } from '../support/addresses.js'
import { deliveredMessage } from '../support/harness.js'

const templates: EmailTemplates = {
  subject: (submission) => `Enquiry from ${submission.name}`,
  text: () => 'text body',
  html: () => '<p>html body</p>'
}

/** Dispatches with `to` or `replyTo` resolving to `address`, and returns what the transport received, if anything. */
async function deliverResolving(field: 'to' | 'replyTo', address: string) {
  const deliver = vi.fn()
  const dispatcher = new EmailDispatcher({
    transport: { deliver },
    templates,
    from: 'noreply@acme.test',
    to: field === 'to' ? () => address : 'owner@acme.test',
    replyTo: field === 'replyTo' ? () => address : undefined
  })
  const refusal = await dispatcher.dispatch({}, dispatchContext()).then(
    () => undefined,
    (error: unknown) => error
  )

  return { refusal, message: deliver.mock.calls.length > 0 ? deliveredMessage(deliver) : undefined }
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

/** The resources a `FileAttachments` enricher on the `cv` field provides for the files a form posted. */
async function attachedResources(files: File[]) {
  const data = new FormData()
  for (const file of files) data.append('cv', file)

  const result = await new FileAttachments({ field: 'cv', attachTo: 'cv' }).enrich(
    {},
    {
      submission: {},
      data,
      requestURL: new URL('https://example.com/api/apply'),
      siteURL: new URL('https://example.com/'),
      submittedAt: new Date('2026-01-02T03:04:05Z'),
      report: vi.fn()
    }
  )
  if (!('provide' in result) || !result.provide) throw new Error('expected attached files')

  return result.provide
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
    'ada@example.com\u0085X-Priority: 1',
    ''
  ])('refuses a `to` function that resolves to several addresses, a header break or nothing (%j)', async (address) => {
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
    'ada@example.com',
    "o'brien@example.com",
    'ada.lovelace+forms@mail.example.com',
    'Ada Lovelace <ada@example.com>',
    'Ada L. Lovelace <ada@example.com>',
    'Zoë <zoë@exämple.example>',
    '"Lovelace, Ada" <ada@example.com>',
    '"Ada; Byron" <ada@example.com>',
    '"ada@home" <ada@example.com>',
    '"Ada (x" <ada@example.com>',
    'Ada<ada@example.com>',
    'Ada   <ada@example.com>',
    '<ada@example.com>',
    '  ada@example.com  ',
    '  "Lovelace, Ada" <ada@example.com>  '
  ])('delivers a bare address, or a plain or quoted name with one address, unchanged (%j)', async (address) => {
    for (const field of ['to', 'replyTo'] as const) {
      const { refusal, message } = await deliverResolving(field, address)

      expect(refusal).toBeUndefined()
      expect(message?.[field]).toBe(address)
    }
  })

  it.each(['to', 'replyTo'] as const)(
    'refuses a second address hidden behind a quote inside a comment, for `%s`',
    async (field) => {
      const address = 'Ada ("x) <ada@example.com>,ada@example.com,"\u{10000}  " <ada@example.com>'
      const { refusal, message } = await deliverResolving(field, address)

      expect(refusal).toMatchObject({ name: 'EmailRecipientError', field })
      expect(message).toBeUndefined()
    }
  )

  it.each([
    '   ',
    'ada',
    '@example.com',
    'ada@',
    'ada@@example.com',
    'ada@localhost',
    'ada@.com',
    'ada@example.',
    'ada@example.com.',
    'ada@.example.com',
    'ada@example..com',
    'Ada <ada@example.com.>',
    'ada@example.com\u00a0',
    '\u3000ada@example.com',
    '\ufeffada@example.com',
    'Ada\u00a0Lovelace <ada@example.com>',
    'ada @example.com',
    'ada@ example.com',
    'ada\u00a0eve@example.com',
    'ada@example.com\u3000eve',
    'ada@example.com\uff0ceve\uff20example.org',
    'a,b@c.d',
    'a(b@c.d',
    'a)b@c.d',
    'a>b@c.d',
    'a\\b@c.d',
    'a]b@c.d',
    'A<b> <ada@example.com>',
    '"x\\" <ada@example.com>',
    'ada\u0085@example.com',
    'ada\u0000@example.com',
    'Ada <ada@localhost>',
    'Ada <ada@example.com eve>',
    'Ada <ada@example.com (x) eve>',
    'Ada <ada @example.com>',
    'Lovelace, Ada <ada@example.com>',
    'Ada; Byron <ada@example.com>',
    'Team: Ada <ada@example.com>',
    'Ada @ home <ada@example.com>',
    '"Ada \\"A, L\\"" <ada@example.com>',
    '"Ada" Lovelace <ada@example.com>',
    'Ada "Lovelace" <ada@example.com>',
    '"Ada" "Lovelace" <ada@example.com>',
    'Ada (a (b c) d) <ada@example.com>',
    'Ada (a \\) b) <ada@example.com>',
    'Ada (home) <ada@example.com>',
    'Ada (x@y) <ada@example.com>',
    'Ada (x, eve@example.org) <ada@example.com>',
    'Ada (a; b) <ada@example.com>',
    'Ada (x, "y) <ada@example.com>',
    'Ada (<eve@example.org>) <ada@example.com>',
    'Ada (x\\, eve\\@example.org) <ada@example.com>',
    'Ada ("y) <ada@example.com>',
    'Ada (") "x, eve@example.org" <ada@example.com>',
    'Ada (a (b "c) d) <ada@example.com>',
    'ada@example.com (Ada)',
    'ada@example.com (home) (work)',
    'ada@example.com (eve@example.org)',
    'ada@example.com (Ada "x)',
    'Ada <ada@example.com> (home)',
    'ada@example.com "eve@example.org"',
    'ada@example.com (x) "eve@example.org"',
    'ada@example.com:"eve@example.org"',
    'ada@example.com."eve@example.org"',
    'ada@"eve@example.org"',
    'ada@example.com eve',
    'ada@example.com <eve>',
    'ada@example.com:eve',
    'ada@example.com:eve:x',
    'ada@example.com:',
    ':x@y.z:e',
    'x:ada@example.com',
    '"eve@example.org" ada@example.com',
    '"eve@example.org":ada@example.com',
    '"x"@example.com',
    '" eve@example.org,eve "@example.com',
    '"eve@example.org,ada"@example.com',
    'Ada <"eve@example.org,ada"@example.com>',
    '"eve@example.org;ada"@example.com',
    'g:"x;eve@example.org"@example.com',
    'Ada <g:"x;eve@example.org"@example.com>',
    'g:"ada@example.com" "x;eve@example.org"@example.com',
    'Team:"eve@example.org" <ada@example.com>',
    '"eve@example.org, ada@example.com"',
    'Ada "<eve@example.org>, <ada@example.com>"',
    '"Ada <eve@example.org>"',
    '=?utf-8?q?eve=40example.org=2C?=ada@example.com',
    'Ada <=?utf-8?q?eve=40example.org=2C?=ada@example.com>',
    'ada@=?utf-8?q?example.com=2C_eve=40example.org?=',
    'Ada <ada@=?utf-8?q?example.com=2C_eve=40example.org?=>',
    '=""?utf-8?q?eve=40example.org=2C?=ada@example.com',
    '=(x)?utf-8?q?eve=40example.org=2C?=ada@example.com',
    '= ?utf-8?q?eve=40example.org=2C?=ada@example.com',
    'Ada <=""?utf-8?q?eve=40example.org=2C?=ada@example.com>',
    'Ada <ada@example.com=(x)?utf-8?q?=2C_eve=40example.org?=>',
    'Ada <"=?utf-8?q?eve=40example.org=2C?="@example.com>',
    '"=?utf-8?q?eve=40example.org=2C?=ada"@example.com',
    '=?utf-8?q?Ada?= <ada@example.com>',
    '=?utf-8?q?eve=40example.org=2C?= <ada@example.com>',
    '=?utf-8?b?ZXZlQGV4YW1wbGUub3JnLA==?= <ada@example.com>',
    '"=?utf-8?q?eve=40example.org=2C?=" <ada@example.com>',
    'ada@[1"], eve@example.org, x@["]',
    'ada@[1(], eve@example.org, x@[)]',
    'ada@[192.0.2.1]',
    'Ada <ada@example.com> eve',
    'Ada <ada@example.com> "eve"',
    'ada@example.com\u2028Bcc: eve@example.com',
    '"Ada\u2029Bcc: eve@example.com" <ada@example.com>',
    'Ada (x <ada@example.com>',
    'Ada (a (b) <ada@example.com>, eve@example.org',
    'Ada x) <ada@example.com>',
    'Ada (x)) <ada@example.com>',
    '"Ada <ada@example.com>',
    'Ada <ada@example.com',
    'Ada ada@example.com>',
    'Ada <<ada@example.com>>',
    'Ada \\", eve@example.org, \\\\" <ada@example.com>',
    '"abc\\',
    '(abc\\',
    'abc\\'
  ])('refuses any other shape (%j)', async (address) => {
    for (const field of ['to', 'replyTo'] as const) {
      const { refusal, message } = await deliverResolving(field, address)

      expect(refusal).toMatchObject({ name: 'EmailRecipientError', field })
      expect(message).toBeUndefined()
    }
  })

  it.each(['to', 'replyTo'] as const)(
    'refuses a `%s` resolver that returns something other than a string',
    async (field) => {
      const { refusal, message } = await deliverResolving(field, 42 as unknown as string)

      expect(refusal).toMatchObject({ name: 'EmailRecipientError', field })
      expect(message).toBeUndefined()
    }
  )

  it('turns control characters in a resolved `from` into spaces', async () => {
    const deliver = vi.fn()
    await new EmailDispatcher({
      transport: { deliver },
      templates,
      from: (submission) => `${submission.name as string} via Example <forms@example.com>`,
      to: 'owner@acme.test'
    }).dispatch({ name: 'Ada\r\n\u0085\u2028Bcc:\u2029eve@example.org' }, dispatchContext())

    expect(deliveredMessage(deliver).from).toBe('Ada Bcc: eve@example.org via Example <forms@example.com>')
  })

  it.each(['\r\n', '\u0085', '\u0000\u009b', '\u2028', '\u2029'])(
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

  it('refuses any resolved address carrying a control character, delivering nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('to', 'replyTo'), textWithControlCharacter, async (field, address) => {
        const { refusal, message } = await deliverResolving(field, address)

        expect(refusal).toMatchObject({ name: 'EmailRecipientError', field })
        expect(message).toBeUndefined()
      })
    )
  })

  it('delivers any quoted display name with one address, unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('to', 'replyTo'), displayName, async (field, name) => {
        const address = `"${name}" <ada@example.com>`
        const { refusal, message } = await deliverResolving(field, address)

        expect(refusal).toBeUndefined()
        expect(message?.[field]).toBe(address)
      })
    )
  })

  it('never accepts an address that an RFC 5322 parser reads as more than one recipient', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('to', 'replyTo'), addressLike, async (field, address) => {
        const { message } = await deliverResolving(field, address)
        if (!message) return

        const recipients = emailAddresses.parseAddressList({ input: address, rfc6532: true })
        if (recipients === null) return

        expect(recipients).toHaveLength(1)
        expect(recipients[0]?.type).toBe('mailbox')
      }),
      { numRuns: 1000 }
    )
  })

  it('never delivers a control character in the subject or a resolved `from`', async () => {
    await fc.assert(
      fc.asyncProperty(textWithControlCharacter, textWithControlCharacter, async (subject, sender) => {
        const deliver = vi.fn()
        await new EmailDispatcher({
          transport: { deliver },
          templates: { ...templates, subject: () => subject },
          from: () => sender,
          to: 'owner@acme.test'
        }).dispatch({}, dispatchContext())

        const message = deliveredMessage(deliver)
        expect(message.subject).not.toMatch(/[\p{Cc}\u2028\u2029]/u)
        expect(message.from).not.toMatch(/[\p{Cc}\u2028\u2029]/u)
      })
    )
  })

  it('keeps the address out of the recipient error', () => {
    expect(new EmailRecipientError().message).not.toContain('@')
  })

  it('names the field in the recipient error', () => {
    expect(new EmailRecipientError('replyTo').message).toContain('`replyTo` resolver')
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

  describe('attachments', () => {
    it("attaches the named key's files to the message", async () => {
      const resources = await attachedResources([
        new File([PDF_BYTES], 'cv.pdf', { type: 'text/plain' }),
        new File([PNG_BYTES], 'portfolio.png', { type: 'application/octet-stream' })
      ])
      const deliver = vi.fn()
      await new EmailDispatcher({
        transport: { deliver },
        templates,
        from: 'from@example.com',
        to: 'to@example.com',
        attach: 'cv'
      }).dispatch({ name: 'Ada' }, dispatchContext({ resources }))

      expect(deliveredMessage(deliver).attachments).toEqual([
        { filename: 'cv.pdf', contentType: 'application/pdf', content: PDF_BYTES },
        { filename: 'portfolio.png', contentType: 'image/png', content: PNG_BYTES }
      ])
    })

    it('sends no attachments property without attach', async () => {
      const resources = await attachedResources([new File([PDF_BYTES], 'cv.pdf')])
      const deliver = vi.fn()
      await new EmailDispatcher({
        transport: { deliver },
        templates,
        from: 'from@example.com',
        to: 'to@example.com'
      }).dispatch({ name: 'Ada' }, dispatchContext({ resources }))

      expect(deliveredMessage(deliver)).not.toHaveProperty('attachments')
    })

    it('sends no attachments property when the form posted no file to attach', async () => {
      const deliver = vi.fn()
      const resources = await attachedResources([])
      await new EmailDispatcher({
        transport: { deliver },
        templates,
        from: 'from@example.com',
        to: 'to@example.com',
        attach: 'cv'
      }).dispatch({ name: 'Ada' }, dispatchContext({ resources }))

      expect(deliveredMessage(deliver)).not.toHaveProperty('attachments')
    })

    it('fails, sending nothing, when no enricher provided the attach key', async () => {
      const deliver = vi.fn()
      const resources = {} as Awaited<ReturnType<typeof attachedResources>>
      const failure = await new EmailDispatcher({
        transport: { deliver },
        templates,
        from: 'from@example.com',
        to: 'to@example.com',
        attach: 'cv'
      })
        .dispatch({ name: 'Ada' }, dispatchContext({ resources }))
        .then(
          () => undefined,
          (error: unknown) => error
        )

      expect(failure).toBeInstanceOf(OperationalError)
      expect(failure).toMatchObject({
        code: 'email.attach-missing',
        message: expect.stringContaining("'cv'")
      })
      expect((failure as OperationalError).message).toMatch(/\.$/)
      expect(deliver).not.toHaveBeenCalled()
    })

    it('leaves exposesResources to the templates, since attached files need no keeping', () => {
      const dispatcher = new EmailDispatcher({
        transport: { deliver: vi.fn() },
        templates: submissionNotificationTemplates<{ name: string }>({ fields: ['name'] }),
        from: 'from@example.com',
        to: 'to@example.com',
        attach: 'cv'
      })

      expect(dispatcher.exposesResources).toBe(false)
    })
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

import { submissionAcknowledgementTemplates } from '#dispatchers/submission-acknowledgement.js'
import { describe, expect, it } from 'vitest'
import { dispatchContext } from '../dispatch-context.js'

const submission = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '',
  message: 'Hello there'
}

// The display host now comes from the dispatch context (siteURL ?? requestURL), not the submission.
const CTX = dispatchContext()

describe('submissionAcknowledgementTemplates', () => {
  it('titles the email with the confirmation heading, not the form name', () => {
    const templates = submissionAcknowledgementTemplates<typeof submission>({
      fields: ['name', 'email'],
      formName: 'Contact form'
    })

    expect(templates.text(submission, CTX)).toContain("We've received your submission")
    expect(templates.html(submission, CTX)).toContain('Thank you')
    // The form name appears in the meta line, not as the title.
    expect(templates.text(submission, CTX)).toContain('Contact form')
  })

  it('defaults the subject to a received-confirmation', () => {
    const templates = submissionAcknowledgementTemplates<typeof submission>({
      fields: ['name'],
      formName: 'Contact form'
    })
    expect(templates.subject(submission, CTX)).toBe("We've received your submission")
  })

  it('shows a default confirmation message, overridable by string or function', () => {
    const defaulted = submissionAcknowledgementTemplates<typeof submission>({ fields: ['name'] })
    expect(defaulted.text(submission, CTX)).toContain('received your submission and will be in touch')

    const custom = submissionAcknowledgementTemplates<typeof submission>({
      fields: ['name'],
      message: 'Your quote request is in the queue.'
    })
    expect(custom.text(submission, CTX)).toContain('Your quote request is in the queue.')

    const computed = submissionAcknowledgementTemplates<typeof submission>({
      fields: ['name'],
      message: (enquiry) => `Thanks ${enquiry.name.split(' ')[0]}!`
    })
    expect(computed.text(submission, CTX)).toContain('Thanks Ada!')
  })

  it('renders a greeting only when one is provided', () => {
    const greeted = submissionAcknowledgementTemplates<typeof submission>({
      fields: ['name'],
      greeting: (enquiry) => `Hi ${enquiry.name},`
    })
    expect(greeted.text(submission, CTX)).toContain('Hi Ada Lovelace,')

    const plain = submissionAcknowledgementTemplates<typeof submission>({ fields: ['name'] })
    expect(plain.text({ ...submission, name: 'Ada' }, CTX)).not.toContain('Hi Ada,')
  })

  it('echoes the declared submission fields back to the sender', () => {
    const templates = submissionAcknowledgementTemplates<typeof submission>({ fields: ['name', 'phone', 'message'] })
    const text = templates.text(submission, CTX)

    expect(text).toContain('Name:\nAda Lovelace')
    expect(text).toContain('Message:\nHello there')
    expect(text).not.toContain('Phone')
  })

  it('uses acknowledgement footer copy and links the site URL from the context', () => {
    const templates = submissionAcknowledgementTemplates<typeof submission>({ fields: ['name'] })
    expect(templates.text(submission, CTX)).toContain("This is an automated acknowledgement; you don't need to reply.")
    expect(templates.text(submission, CTX)).toContain('https://example.com/')
    expect(templates.html(submission, CTX)).toContain('href="https://example.com/"')

    // Falls back to the request origin when no Astro site is configured.
    const context = dispatchContext({ host: 'forms.example.org', siteURL: null })
    expect(templates.text(submission, context)).toContain('https://forms.example.org/')
  })

  it('escapes field values in the html body only', () => {
    const hostile = { ...submission, name: 'Ada & <Co>' }
    const templates = submissionAcknowledgementTemplates<typeof hostile>({ fields: ['name'] })

    expect(templates.html(hostile, CTX)).toContain('Ada &amp; &lt;Co&gt;')
    expect(templates.text(hostile, CTX)).toContain('Name:\nAda & <Co>')
  })

  it('stamps the render time in UTC by default', () => {
    const templates = submissionAcknowledgementTemplates<typeof submission>({
      fields: ['name'],
      formName: 'Contact form'
    })
    expect(templates.text(submission, CTX)).toMatch(/\d{1,2} \w{3,4} \d{4}, \d{2}:\d{2} UTC/)
  })

  it('overrides the fixed UI copy for translation, keeping the same HTML shell', () => {
    const templates = submissionAcknowledgementTemplates<typeof submission>({
      fields: ['name'],
      message: 'Merci de votre message.',
      copy: {
        eyebrow: 'Merci',
        heading: 'Nous avons bien reçu votre message',
        footerText: 'Ceci est un accusé de réception automatique.'
      }
    })
    const html = templates.html(submission, CTX)

    expect(html).toContain('Merci')
    expect(html).toContain('<title>Nous avons bien reçu votre message</title>')
    expect(html).toContain('Merci de votre message.')
    expect(html).toContain('Ceci est un accusé de réception automatique.')
    expect(templates.text(submission, CTX)).toContain('Nous avons bien reçu votre message')
  })

  it('sends a plain acknowledgement with no fields — no copied-submission block or divider', () => {
    const templates = submissionAcknowledgementTemplates({ message: 'Thanks — we got your message.' })
    const sub = { name: 'Ada', email: 'ada@example.com' }

    expect(templates.text(sub, CTX)).toContain('Thanks — we got your message.')
    expect(templates.text(sub, CTX)).not.toContain('==========')
    expect(templates.text(sub, CTX)).not.toContain('Name:')
    expect(templates.html(sub, CTX)).not.toContain('class="email__rule"')
  })

  it('renders in-card contact details when provided, omitting them by default', () => {
    const sub = { name: 'Ada' }
    const withContact = submissionAcknowledgementTemplates({
      message: 'Thanks!',
      contact: { email: 'support@acme.test', phone: '+44 20 1234 5678', address: '1 High St, London' }
    })
    const html = withContact.html(sub, CTX)

    expect(html).toContain('mailto:support@acme.test')
    expect(html).toContain('href="tel:+442012345678"')
    expect(html).toContain('+44 20 1234 5678')
    expect(html).toContain('1 High St, London')
    expect(withContact.text(sub, CTX)).toContain('support@acme.test')
    expect(withContact.text(sub, CTX)).toContain('1 High St, London')

    const withoutContact = submissionAcknowledgementTemplates({ message: 'Thanks!' })
    expect(withoutContact.html(sub, CTX)).not.toContain('mailto:')
  })

  it('renders attachment links, dropping unsafe schemes', () => {
    const templates = submissionAcknowledgementTemplates<{ name: string }, 'files'>({
      fields: ['name'],
      attachments: 'files'
    })
    const ctx = dispatchContext({
      resources: {
        files: [
          { name: 'quote.pdf', url: 'https://example.com/files/aaa~bbb/' },
          { name: 'evil', url: 'javascript:alert(1)' }
        ]
      }
    })
    const html = templates.html({ name: 'Ada' }, ctx)

    expect(html).toContain('quote.pdf</a>')
    expect(html).not.toContain('javascript:')
  })

  it('marks the templates as exposing resources only when an attachments field is configured', () => {
    const withAttachments = submissionAcknowledgementTemplates<{ name: string }, 'files'>({
      attachments: 'files'
    })
    expect(withAttachments.exposesResources).toBe(true)

    const withoutAttachments = submissionAcknowledgementTemplates({ message: 'Thanks!' })
    expect(withoutAttachments.exposesResources).toBe(false)
  })
})

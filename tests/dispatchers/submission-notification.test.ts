import { submissionAcknowledgementTemplates } from '#dispatchers/submission-acknowledgement.js'
import { submissionNotificationTemplates } from '#dispatchers/submission-notification.js'
import { describe, expect, it, vi } from 'vitest'
import { dispatchContext } from '../dispatch-context.js'

const submission = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '',
  preferredTime: 'Morning',
  message: 'Hello there'
}

// The display host now comes from the dispatch context (siteURL ?? requestURL), not the submission.
const CTX = dispatchContext()

describe('submissionNotificationTemplates', () => {
  it('renders declared fields with humanised labels and drops empty ones', () => {
    const templates = submissionNotificationTemplates<typeof submission>({
      fields: ['name', 'email', 'phone', 'preferredTime']
    })
    const text = templates.text(submission, CTX)

    expect(text).toContain('Name:\nAda Lovelace')
    expect(text).toContain('Email:\nada@example.com')
    expect(text).toContain('Preferred Time:\nMorning')
    expect(text).not.toContain('Phone')
  })

  it('respects explicit labels and computed values in field specs', () => {
    const templates = submissionNotificationTemplates<typeof submission>({
      fields: [{ label: 'Contact', value: (enquiry) => `${enquiry.name} <${enquiry.email}>` }]
    })
    expect(templates.text(submission, CTX)).toContain('Contact:\nAda Lovelace <ada@example.com>')
  })

  it('renders a free-text field like any other, with line breaks preserved', () => {
    const multiline = { name: 'Ada', message: 'First line.\n\nSecond paragraph.' }
    const templates = submissionNotificationTemplates<typeof multiline>({ fields: ['name', 'message'] })

    expect(templates.text(multiline, CTX)).toContain('Message:\nFirst line.\n\nSecond paragraph.')
    expect(templates.html(multiline, CTX)).toContain('First line.\n\nSecond paragraph.')
  })

  it('drops an empty free-text field, like any other empty field', () => {
    const templates = submissionNotificationTemplates<typeof submission>({ fields: ['name', 'message'] })
    expect(templates.text({ ...submission, message: '' }, CTX)).not.toContain('Message:')
  })

  it('mentions the site host in the subject and header, and links the site URL in the footer', () => {
    const templates = submissionNotificationTemplates<typeof submission>({ fields: ['name'] })
    expect(templates.subject(submission, CTX)).toBe('New form submission via example.com')
    expect(templates.text(submission, CTX)).toContain('via example.com')
    expect(templates.text(submission, CTX)).toContain('https://example.com/')
    expect(templates.html(submission, CTX)).toContain('href="https://example.com/"')
  })

  it('falls back to the request origin when no Astro site is configured', () => {
    const templates = submissionNotificationTemplates<typeof submission>({ fields: ['name'] })
    const context = dispatchContext({ host: 'forms.example.org', siteURL: null })
    expect(templates.subject(submission, context)).toBe('New form submission via forms.example.org')
    expect(templates.text(submission, context)).toContain('https://forms.example.org/')
  })

  it('renders a custom subject source against the submission', () => {
    const templates = submissionNotificationTemplates<typeof submission>({
      fields: ['name'],
      subject: 'New enquiry from {{name}} via {{siteHost}}'
    })
    expect(templates.subject(submission, CTX)).toBe('New enquiry from Ada Lovelace via example.com')
  })

  it('escapes field values in the html body only', () => {
    const hostile = { ...submission, name: 'Ada & <Co>', message: 'a < b' }
    const templates = submissionNotificationTemplates<typeof hostile>({ fields: ['name', 'message'] })

    expect(templates.html(hostile, CTX)).toContain('Ada &amp; &lt;Co&gt;')
    expect(templates.html(hostile, CTX)).toContain('a &lt; b')
    expect(templates.text(hostile, CTX)).toContain('Name:\nAda & <Co>')
  })

  it('passes the context to computed fields (parity with Discord)', () => {
    const templates = submissionNotificationTemplates<typeof submission>({
      fields: [{ label: 'Status', value: (_submission, context) => (context.quarantined ? 'flagged' : 'ok') }]
    })

    expect(templates.text(submission, dispatchContext({ quarantined: true }))).toContain('flagged')
    expect(templates.text(submission, dispatchContext())).toContain('ok')
  })
})

describe('submissionNotificationTemplates presentation options', () => {
  it('shows the form name in the subject, title, and text header', () => {
    const templates = submissionNotificationTemplates<typeof submission>({ fields: ['name'], formName: 'Contact form' })

    expect(templates.subject(submission, CTX)).toBe('New form submission: Contact form via example.com')
    expect(templates.text(submission, CTX)).toContain('Contact form')
    expect(templates.html(submission, CTX)).toContain('Contact form')
  })

  it('falls back to a generic heading when no form name is given', () => {
    const templates = submissionNotificationTemplates<typeof submission>({ fields: ['name'] })
    expect(templates.text(submission, CTX)).toContain('New form submission')
    expect(templates.html(submission, CTX)).toContain('<title>New form submission</title>')
  })

  it('overrides the fixed UI copy for translation, keeping the same HTML shell', () => {
    const templates = submissionNotificationTemplates<typeof submission, 'files'>({
      fields: ['name'],
      attachments: 'files',
      copy: {
        eyebrow: 'Nouvelle soumission',
        heading: 'Nouveau message',
        attachmentsLabel: 'Pièces jointes',
        footerText: 'Ceci est une notification automatique.'
      }
    })
    const ctx = dispatchContext({ resources: { files: [{ name: 'devis.pdf', url: 'https://example.com/f/a/' }] } })
    const html = templates.html(submission, ctx)

    expect(html).toContain('Nouvelle soumission')
    expect(html).toContain('<title>Nouveau message</title>')
    expect(html).toContain('Pièces jointes')
    expect(html).toContain('Ceci est une notification automatique.')
    expect(templates.text(submission, ctx)).toContain('Nouveau message')
  })

  it('shows the brand wordmark only when configured', () => {
    const branded = submissionNotificationTemplates<typeof submission>({
      fields: ['name'],
      brandName: 'Nialto Services'
    })
    expect(branded.html(submission, CTX)).toContain('Nialto Services')

    const plain = submissionNotificationTemplates<typeof submission>({ fields: ['name'] })
    expect(plain.html(submission, CTX)).not.toContain('email__wordmark</span>')
  })

  it('formats the shared arrival instant from the context in UTC by default', () => {
    const templates = submissionNotificationTemplates<typeof submission>({ fields: ['name'] })
    expect(templates.text(submission, CTX)).toMatch(/· \d{1,2} \w{3,4} \d{4}, \d{2}:\d{2} UTC/)

    // dispatchContext defaults submittedAt to 2026-01-02T03:04:05Z.
    expect(templates.text(submission, CTX)).toContain('· 2 Jan 2026, 03:04 UTC')
  })

  it('honours a custom submittedAt producer, including omission', () => {
    const stamped = submissionNotificationTemplates<typeof submission>({
      fields: ['name'],
      submittedAt: () => 'yesterday, probably'
    })
    expect(stamped.text(submission, CTX)).toContain('· yesterday, probably')

    const unstamped = submissionNotificationTemplates<typeof submission>({
      fields: ['name'],
      submittedAt: () => undefined
    })
    expect(unstamped.text(submission, CTX)).not.toContain('·')
  })

  it('passes the dispatch context to a custom submittedAt producer', () => {
    const submittedAt = vi.fn((_submission: typeof submission, context: typeof CTX) =>
      context.submittedAt.toISOString()
    )
    const templates = submissionNotificationTemplates<typeof submission>({ fields: ['name'], submittedAt })

    // The override reads the shared instant off the context, so its return value proves it received it.
    expect(templates.text(submission, CTX)).toContain(CTX.submittedAt.toISOString())
    expect(submittedAt).toHaveBeenCalledWith(submission, CTX)
  })

  it('renders the identical timestamp in the notification and acknowledgement for one submission', () => {
    const notification = submissionNotificationTemplates<typeof submission>({ fields: ['name'] })
    const acknowledgement = submissionAcknowledgementTemplates<typeof submission>({ fields: ['name'] })

    // Both templates read `context.submittedAt`, so one shared instant renders one string in both emails.
    expect(notification.text(submission, CTX)).toContain('2 Jan 2026, 03:04 UTC')
    expect(acknowledgement.text(submission, CTX)).toContain('2 Jan 2026, 03:04 UTC')
  })
})

describe('submissionNotificationTemplates attachments', () => {
  const person = { name: 'Ada Lovelace' }

  // Attachments live on the dispatch context's `resources`, not the submission; the `attachments`
  // option names the resource key a `FileUploads` enricher exposed via its `attachTo`.
  const templates = submissionNotificationTemplates<typeof person, 'files'>({ fields: ['name'], attachments: 'files' })

  const withFiles = dispatchContext({
    resources: {
      files: [
        { name: 'quote.pdf', url: 'https://example.com/files/aaa~bbb/' },
        { name: 'photo.png', url: 'https://example.com/files/ccc~ddd/' }
      ]
    }
  })

  it('renders each attachment as a download link in the html body', () => {
    const html = templates.html(person, withFiles)

    expect(html).toMatch(/<a href="https:.+aaa~bbb.+">quote\.pdf<\/a>/)
    expect(html).toContain('photo.png</a>')
  })

  it('lists attachments as name/url pairs in the text body', () => {
    const text = templates.text(person, withFiles)

    expect(text).toContain('Attachments:')
    expect(text).toContain('quote.pdf: https://example.com/files/aaa~bbb/')
  })

  it('shows a human-readable file size beside each link when the source carries one', () => {
    const sized = dispatchContext({
      resources: {
        files: [
          { name: 'quote.pdf', url: 'https://example.com/files/aaa~bbb/', size: 2_621_440 },
          { name: 'photo.png', url: 'https://example.com/files/ccc~ddd/', size: 322_560 }
        ]
      }
    })

    expect(templates.html(person, sized)).toContain('2.5 MB')
    expect(templates.text(person, sized)).toContain('quote.pdf (2.5 MB): https://example.com/files/aaa~bbb/')
    expect(templates.text(person, sized)).toContain('photo.png (315 KB): https://example.com/files/ccc~ddd/')
  })

  it('omits the size beside a link when the source has none', () => {
    const text = templates.text(person, withFiles)

    expect(text).toContain('quote.pdf: https://example.com/files/aaa~bbb/')
    expect(text).not.toContain('(')
  })

  it('escapes a hostile attachment name in the html body', () => {
    const hostile = dispatchContext({
      resources: { files: [{ name: '<script>x</script>', url: 'https://example.com/files/x/' }] }
    })
    const html = templates.html(person, hostile)

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>x')
  })

  it('cannot break the href attribute with a quote in the url', () => {
    const hostile = dispatchContext({
      resources: { files: [{ name: 'x.pdf', url: 'https://example.com/"onmouseover="alert(1)' }] }
    })
    const html = templates.html(person, hostile)

    expect(html).not.toContain('onmouseover="alert(1)"')
    expect(html).toContain('&quot;onmouseover')
  })

  it('drops an attachment whose url uses an unsafe scheme', () => {
    const hostile = dispatchContext({ resources: { files: [{ name: 'evil', url: 'javascript:alert(1)' }] } })

    expect(templates.html(person, hostile)).not.toContain('Attachments')
    expect(templates.html(person, hostile)).not.toContain('javascript:')
  })

  it('omits the attachments section entirely when there are none', () => {
    const empty = dispatchContext({ resources: { files: [] } })

    expect(templates.html(person, empty)).not.toContain('Attachments')
    expect(templates.text(person, empty)).not.toContain('Attachments')
  })

  it('marks the templates as exposing resources only when an attachments field is configured', () => {
    expect(templates.exposesResources).toBe(true)

    const withoutAttachments = submissionNotificationTemplates<typeof person>({ fields: ['name'] })
    expect(withoutAttachments.exposesResources).toBe(false)
  })
})

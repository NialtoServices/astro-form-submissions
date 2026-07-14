import { renderEmail } from '#dispatchers/email.js'
import { mustacheTemplates } from '#dispatchers/mustache.js'
import { describe, expect, it } from 'vitest'
import { dispatchContext } from '../dispatch-context.js'

const submission = {
  name: "O'Brien & Sons <Ltd>",
  email: 'obrien@example.com',
  message: 'Hello there',
  siteHost: 'example.com'
}

describe('mustacheTemplates', () => {
  it('renders the submission into the subject, text, and html sources', () => {
    const templates = mustacheTemplates({
      subject: 'New enquiry via {{siteHost}}',
      text: 'Message: {{message}}',
      html: '<p>{{message}}</p>'
    })

    expect(templates.subject(submission, dispatchContext())).toBe('New enquiry via example.com')
    expect(templates.text(submission, dispatchContext())).toBe('Message: Hello there')
    expect(templates.html(submission, dispatchContext())).toBe('<p>Hello there</p>')
  })

  it('escapes interpolations in the html body', () => {
    const templates = mustacheTemplates({ subject: '-', text: '-', html: '<p>{{name}}</p>' })
    expect(templates.html(submission, dispatchContext())).toBe('<p>O&#39;Brien &amp; Sons &lt;Ltd&gt;</p>')
  })

  it('leaves the subject and text body unescaped — they are not HTML documents', () => {
    const templates = mustacheTemplates({ subject: 'From {{name}}', text: 'Name: {{name}}', html: '-' })
    expect(templates.subject(submission, dispatchContext())).toBe("From O'Brien & Sons <Ltd>")
    expect(templates.text(submission, dispatchContext())).toBe("Name: O'Brien & Sons <Ltd>")
  })

  it('passes triple-stache interpolations through raw for trusted markup', () => {
    const templates = mustacheTemplates({ subject: '-', text: '-', html: '{{{markup}}}' })
    expect(templates.html({ markup: '<hr />' }, dispatchContext())).toBe('<hr />')
  })

  it('omits optional sections without leaving blank lines', () => {
    const templates = mustacheTemplates({
      subject: '-',
      text: 'Name: {{name}}\n{{#phone}}\nPhone: {{phone}}\n{{/phone}}\nMessage: {{message}}',
      html: '-'
    })
    expect(templates.text(submission, dispatchContext())).toBe("Name: O'Brien & Sons <Ltd>\nMessage: Hello there")
  })

  it('renders optional sections when the value is present', () => {
    const templates = mustacheTemplates({
      subject: '-',
      text: '{{#phone}}Phone: {{phone}}{{/phone}}',
      html: '-'
    })
    expect(templates.text({ ...submission, phone: '01234 567890' }, dispatchContext())).toBe('Phone: 01234 567890')
  })

  it('renders through the view transform when provided', () => {
    const templates = mustacheTemplates<typeof submission>({
      subject: '-',
      text: 'Shouting: {{loudName}}',
      html: '-',
      view: (enquiry) => ({ ...enquiry, loudName: enquiry.name.toUpperCase() })
    })
    expect(templates.text(submission, dispatchContext())).toBe("Shouting: O'BRIEN & SONS <LTD>")
  })

  it('produces templates renderEmail consumes like any hand-written ones', () => {
    const templates = mustacheTemplates<typeof submission>({
      subject: 'Enquiry from {{name}}',
      text: '{{message}}',
      html: '<p>{{message}}</p>'
    })
    expect(renderEmail(templates, submission, dispatchContext())).toEqual({
      subject: "Enquiry from O'Brien & Sons <Ltd>",
      text: 'Hello there',
      html: '<p>Hello there</p>'
    })
  })
})

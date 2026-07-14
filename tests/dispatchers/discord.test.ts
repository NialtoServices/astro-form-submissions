import { DiscordDispatcher, type DiscordFieldInput } from '#dispatchers/discord.js'
import { type FormSubmission } from '#pipeline.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchContext } from '../dispatch-context.js'
import { stubFetch } from '../support/harness.js'

interface Embed {
  title: string
  description?: string
  fields: { name: string; value: string }[]
  color: number
}

/** Send via the notifier and return the embed Discord would have received. */
async function capture<E extends FormSubmission>(
  submission: E,
  options: Partial<ConstructorParameters<typeof DiscordDispatcher<E>>[0]> = {},
  disposition: { quarantined?: boolean; quarantineReasons?: readonly string[] } = {}
): Promise<Embed> {
  let body: { embeds: Embed[] } | undefined
  stubFetch((_requestUrl, requestInit) => {
    body = JSON.parse(requestInit?.body as string)
    return new Response('', { status: 200 })
  })

  await new DiscordDispatcher<E>({ webhookUrl: 'https://discord.test/hook', fields: [], ...options }).dispatch(
    submission,
    dispatchContext(disposition)
  )
  return body!.embeds[0]!
}

const base: FormSubmission = { name: 'Ada', siteHost: 'example.com' }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DiscordDispatcher embed limits', () => {
  it('clamps an oversize title to 256 code points with an ellipsis', async () => {
    const embed = await capture(base, { title: () => 'A'.repeat(300) })
    expect([...embed.title].length).toBe(256)
    expect(embed.title.endsWith('…')).toBe(true)
  })

  it('clamps an oversize field value to 1024 code points', async () => {
    const embed = await capture({ ...base, company: 'C'.repeat(2000) }, { fields: ['company'] })
    expect([...embed.fields[0]!.value].length).toBe(1024)
  })

  it('caps the field count at 25', async () => {
    const fields: DiscordFieldInput<FormSubmission>[] = Array.from({ length: 30 }, (_unusedValue, index) => ({
      label: `F${index}`,
      value: () => 'x'
    }))
    const embed = await capture(base, { fields })
    expect(embed.fields.length).toBe(25)
  })

  it('drops a field whose resolved name is empty', async () => {
    const embed = await capture(base, { fields: [{ value: () => 'orphan' }] })
    expect(embed.fields.length).toBe(0)
  })

  it('drops builder fields with an empty name or value', async () => {
    const embed = await capture(base, {
      fields: () => [
        { name: '', value: 'no-name' },
        { name: 'no-value', value: '' },
        { name: 'kept', value: 'yes' }
      ]
    })
    expect(embed.fields).toEqual([{ name: 'kept', value: 'yes' }])
  })

  it('keeps a fields-only embed within the 6000-char total, dropping trailing fields', async () => {
    // Ten value-capped fields sum past 10,000 chars; without a description the budget must still apply.
    const fields: DiscordFieldInput<FormSubmission>[] = Array.from({ length: 10 }, (_unusedValue, index) => ({
      label: `F${index}`,
      value: () => 'x'.repeat(2000)
    }))
    const embed = await capture(base, { fields })

    const total =
      embed.title.length +
      embed.fields.reduce((totalLength, field) => totalLength + field.name.length + field.value.length, 0)
    expect(total).toBeLessThanOrEqual(6000)
    expect(embed.fields.length).toBeLessThan(10)
    expect(embed.description).toBeUndefined()
  })

  it('keeps the whole embed within the 6000-char budget', async () => {
    const embed = await capture(
      { ...base, message: 'M'.repeat(5000), company: 'C'.repeat(2000) },
      { fields: ['company'], title: () => 'T'.repeat(300), description: (submission) => String(submission.message) }
    )
    const total =
      embed.title.length +
      (embed.description ?? '').length +
      embed.fields.reduce((totalLength, field) => totalLength + field.name.length + field.value.length, 0)
    expect(total).toBeLessThanOrEqual(6000)
  })

  it('truncates a surrogate-heavy description without leaving a lone surrogate', async () => {
    const embed = await capture(
      { ...base, message: '😀'.repeat(5000) },
      { description: (submission) => String(submission.message) }
    )
    expect([...(embed.description ?? '')].length).toBeLessThanOrEqual(4096)
    expect((embed.description ?? '').isWellFormed()).toBe(true)
  })

  it('omits the description when none is provided', async () => {
    const embed = await capture(base)
    expect(embed.description).toBeUndefined()
  })
})

describe('DiscordDispatcher quarantine disposition', () => {
  it('threads the disposition into title, description, and field callbacks', async () => {
    const embed = await capture(
      base,
      {
        title: (_submission, context) => (context.quarantined ? 'Blocked submission' : 'New submission'),
        description: (_submission, context) => `reason: ${context.quarantineReasons.join(', ')}`,
        fields: [{ label: 'Flags', value: (_submission, context) => (context.quarantined ? 'spam' : 'clean') }]
      },
      { quarantined: true, quarantineReasons: ['keyword match'] }
    )
    expect(embed.title).toBe('Blocked submission')
    expect(embed.description).toBe('reason: keyword match')
    expect(embed.fields).toEqual([{ name: 'Flags', value: 'spam', inline: true }])
  })

  it('threads the disposition into the builder-function fields form', async () => {
    const embed = await capture(
      base,
      { fields: (_submission, context) => [{ name: 'Spam', value: String(context.quarantined) }] },
      { quarantined: true }
    )
    expect(embed.fields).toEqual([{ name: 'Spam', value: 'true' }])
  })
})

describe('DiscordDispatcher dispatcher contract', () => {
  it('defaults acceptsQuarantined to false, opting in only when set', () => {
    expect(new DiscordDispatcher({ webhookUrl: 'https://discord.test/hook', fields: [] }).acceptsQuarantined).toBe(
      false
    )
    expect(
      new DiscordDispatcher({ webhookUrl: 'https://discord.test/hook', fields: [], acceptsQuarantined: true })
        .acceptsQuarantined
    ).toBe(true)
  })

  it('is best-effort (not required) by default', () => {
    expect(new DiscordDispatcher({ webhookUrl: 'https://discord.test/hook', fields: [] }).required).toBe(false)
    expect(
      new DiscordDispatcher({ webhookUrl: 'https://discord.test/hook', fields: [], required: true }).required
    ).toBe(true)
  })

  it('throws a delivery error carrying the HTTP status when Discord responds non-2xx (OBS-001)', async () => {
    stubFetch(() => new Response('', { status: 429 }))
    const error = await new DiscordDispatcher({ webhookUrl: 'https://discord.test/hook', fields: [] })
      .dispatch(base, dispatchContext())
      .catch((thrown: unknown) => thrown)

    // The status is a property (so the PII-safe reporter can log it), and the URL never appears.
    expect((error as { status?: unknown }).status).toBe(429)
    expect(String(error)).not.toContain('discord.test')
  })
})

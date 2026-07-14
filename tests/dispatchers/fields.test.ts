import { resolveField, resolveFields } from '#dispatchers/fields.js'
import type { FormSubmission } from '#pipeline.js'
import { describe, expect, it } from 'vitest'
import { dispatchContext } from '../dispatch-context.js'

const submission: FormSubmission = { email: 'ada@example.com', preferred_time: 'noon', empty: '' }

describe('resolveField', () => {
  it('resolves a bare key with a humanised label', () => {
    expect(resolveField('preferred_time', submission, dispatchContext())).toEqual({
      label: 'Preferred Time',
      value: 'noon'
    })
  })

  it('prefers an explicit label over the humanised key', () => {
    expect(resolveField({ key: 'email', label: 'Address' }, submission, dispatchContext())).toEqual({
      label: 'Address',
      value: 'ada@example.com'
    })
  })

  it('computes values with access to the context', () => {
    const field = resolveField(
      { label: 'Flags', value: (_submission, context) => (context.quarantined ? 'spam' : 'clean') },
      submission,
      dispatchContext({ quarantined: true })
    )
    expect(field).toEqual({ label: 'Flags', value: 'spam' })
  })

  it('drops a field whose value resolves empty', () => {
    expect(resolveField('empty', submission, dispatchContext())).toBeNull()
    expect(resolveField('missing', submission, dispatchContext())).toBeNull()
  })

  it('drops a value-only spec with no label', () => {
    expect(resolveField({ value: () => 'orphan' }, submission, dispatchContext())).toBeNull()
  })
})

describe('resolveFields', () => {
  it('resolves in order and drops empties', () => {
    const fields = resolveFields(
      ['email', 'empty', { key: 'preferred_time', label: 'Time' }],
      submission,
      dispatchContext()
    )
    expect(fields).toEqual([
      { label: 'Email', value: 'ada@example.com' },
      { label: 'Time', value: 'noon' }
    ])
  })
})

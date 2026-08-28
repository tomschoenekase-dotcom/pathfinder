import { describe, expect, it } from 'vitest'

import { parseEntryPrompt, parseGuestEntrySource } from './entry-prompt'

describe('entry prompt boundary', () => {
  it('normalizes a bounded prompt without sending it', () => {
    expect(parseEntryPrompt('  Tell me   about the Tide Clock. ')).toBe(
      'Tell me about the Tide Clock.',
    )
  })

  it.each([null, '', ' '.repeat(20), 'a'.repeat(181)])(
    'rejects absent or oversized input',
    (value) => {
      expect(parseEntryPrompt(value)).toBe('')
    },
  )
})

describe('guest entry source boundary', () => {
  it('accepts only the bounded QR source marker', () => {
    expect(parseGuestEntrySource('qr')).toBe('qr')
  })

  it.each([null, '', 'QR', 'website', 'qr-extra'])('rejects unsupported source %s', (source) => {
    expect(parseGuestEntrySource(source)).toBeUndefined()
  })
})

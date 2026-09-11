import { describe, expect, it } from 'vitest'

import { parseEntryPrompt, parseGuestEntryPlaceId, parseGuestEntrySource } from './entry-prompt'

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

describe('guest entry place boundary', () => {
  it('accepts a bounded item only for the dashboard QR contract', () => {
    expect(parseGuestEntryPlaceId({ entry: 'guide-item', source: 'qr', item: ' place-123 ' })).toBe(
      'place-123',
    )
  })

  it.each([
    { entry: null, source: 'qr', item: 'place-123' },
    { entry: 'guide-item', source: null, item: 'place-123' },
    { entry: 'guide-item', source: 'qr', item: null },
    { entry: 'guide-item', source: 'qr', item: '' },
    { entry: 'guide-item', source: 'qr', item: 'a'.repeat(192) },
    { entry: 'guide-item', source: 'qr', item: 'place\n123' },
  ])('rejects an incomplete or unsafe QR item contract', (input) => {
    expect(parseGuestEntryPlaceId(input)).toBeUndefined()
  })
})

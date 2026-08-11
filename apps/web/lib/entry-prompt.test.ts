import { describe, expect, it } from 'vitest'

import { parseEntryPrompt } from './entry-prompt'

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

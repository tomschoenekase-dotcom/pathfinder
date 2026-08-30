import { describe, expect, it } from 'vitest'

import { safeGmailSourceUrl } from './gmail-source-url'

describe('safeGmailSourceUrl', () => {
  it('admits the exact Gmail source shape', () => {
    expect(
      safeGmailSourceUrl('https://mail.google.com/mail/u/team%40torchiko.com/#all/message%2Fone'),
    ).toBe('https://mail.google.com/mail/u/team%40torchiko.com/#all/message%2Fone')
  })

  it.each([
    null,
    'javascript:alert(1)',
    'http://mail.google.com/mail/u/team@example.com/#all/one',
    'https://mail.google.com.attacker.example/mail/u/team@example.com/#all/one',
    'https://user:secret@mail.google.com/mail/u/team@example.com/#all/one',
    'https://mail.google.com/calendar/event',
  ])('rejects an unsafe or non-Gmail source: %s', (value) => {
    expect(safeGmailSourceUrl(value)).toBeNull()
  })
})

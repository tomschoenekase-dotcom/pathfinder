import { describe, expect, it } from 'vitest'

import { foldProspectEmailStatus } from './prospect-send-outbox-actions'

describe('prospect provider event folding', () => {
  it.each([
    ['DELIVERED', 'SENT', 'DELIVERED'],
    ['BOUNCED', 'DELIVERED', 'BOUNCED'],
    ['COMPLAINED', 'SENT', 'COMPLAINED'],
    ['SUPPRESSED', 'DELIVERED', 'SUPPRESSED'],
    ['QUEUED', 'SENT', 'SENT'],
  ] as const)('folds %s then %s to %s', (current, incoming, expected) => {
    expect(foldProspectEmailStatus(current, incoming)).toBe(expected)
  })
})

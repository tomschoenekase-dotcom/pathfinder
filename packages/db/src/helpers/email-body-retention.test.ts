import { describe, expect, it, vi } from 'vitest'

import { inspectGmailBodyRetentionDryRun } from './email-body-retention'

describe('Gmail body retention inventory', () => {
  it('is bounded and read-only', async () => {
    const findMany = vi.fn(async () => [
      {
        id: 'legacy_1',
        bodyRetentionState: 'LEGACY_REVIEW_REQUIRED' as const,
        textBody: 'legacy',
        htmlBody: null,
        bodyExpiresAt: null,
      },
      {
        id: 'expired_1',
        bodyRetentionState: 'TEMPORARY' as const,
        textBody: 'temporary',
        htmlBody: null,
        bodyExpiresAt: new Date('2026-08-21T00:00:00Z'),
      },
    ])
    const client = { prospectEmailMessage: { findMany } }
    const result = await inspectGmailBodyRetentionDryRun(
      { now: new Date('2026-08-22T00:00:00Z'), limit: 500 },
      client as never,
    )
    expect(result).toMatchObject({ scanned: 2, legacyReviewRequired: 1, eligibleForRemoval: 1 })
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }))
    expect(Object.keys(client.prospectEmailMessage)).toEqual(['findMany'])
  })
})

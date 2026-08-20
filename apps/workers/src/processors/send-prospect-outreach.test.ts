import { afterEach, describe, expect, it } from 'vitest'

import {
  _setProspectCorrespondenceProviderForTesting,
  processSendProspectOutreachJob,
  prospectSendOperationFingerprint,
  isProspectRecipientAllowed,
} from './send-prospect-outreach'

describe('prospect correspondence worker safety', () => {
  const original = process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED
  const originalMode = process.env.PROSPECT_OUTREACH_RECIPIENT_MODE
  const originalAllowlist = process.env.PROSPECT_OUTREACH_INTERNAL_ALLOWLIST

  afterEach(() => {
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = original
    process.env.PROSPECT_OUTREACH_RECIPIENT_MODE = originalMode
    process.env.PROSPECT_OUTREACH_INTERNAL_ALLOWLIST = originalAllowlist
    _setProspectCorrespondenceProviderForTesting(undefined)
  })

  it('defaults to an exact internal-recipient allowlist and requires an explicit production mode', () => {
    delete process.env.PROSPECT_OUTREACH_RECIPIENT_MODE
    process.env.PROSPECT_OUTREACH_INTERNAL_ALLOWLIST = 'Internal@One.test, second@one.test'
    expect(isProspectRecipientAllowed('internal@one.test')).toBe(true)
    expect(isProspectRecipientAllowed('prospect@external.test')).toBe(false)
    process.env.PROSPECT_OUTREACH_RECIPIENT_MODE = 'production'
    expect(isProspectRecipientAllowed('prospect@external.test')).toBe(true)
  })

  it('stays dark before any database claim or provider resolution', async () => {
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = 'false'
    await expect(processSendProspectOutreachJob({ outboxId: 'outbox-1' })).rejects.toThrow(
      'disabled',
    )
  })

  it('uses durable outbox identity rather than a mutable draft or recipient', () => {
    expect(prospectSendOperationFingerprint('outbox-1')).toHaveLength(64)
    expect(prospectSendOperationFingerprint('outbox-1')).toBe(
      prospectSendOperationFingerprint('outbox-1'),
    )
    expect(prospectSendOperationFingerprint('outbox-1')).not.toBe(
      prospectSendOperationFingerprint('outbox-2'),
    )
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  _setProspectOutreachResendClientForTesting,
  processSendProspectOutreachJob,
} from './send-prospect-outreach'

describe('prospect outreach delivery guard', () => {
  afterEach(() => {
    delete process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED
    _setProspectOutreachResendClientForTesting(undefined)
  })

  it('fails closed before provider or database access when delivery is disabled', async () => {
    const send = vi.fn()
    _setProspectOutreachResendClientForTesting({ emails: { send } } as never)
    await expect(processSendProspectOutreachJob({ sendItemId: 'item-1' })).rejects.toThrow(
      'disabled',
    )
    expect(send).not.toHaveBeenCalled()
  })
})

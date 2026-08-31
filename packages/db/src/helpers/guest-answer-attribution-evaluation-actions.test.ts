import { describe, expect, it, vi } from 'vitest'

import {
  failGuestAnswerAttributionEvaluationRequestAction,
  GuestAnswerAttributionEvaluationError,
} from './guest-answer-attribution-evaluation-actions'

const scope = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  requestId: '11111111-1111-4111-8111-111111111111',
  leaseToken: '22222222-2222-4222-8222-222222222222',
}

describe('guest answer attribution evaluation failure boundary', () => {
  it('rejects unknown failure codes before persistence', async () => {
    const updateMany = vi.fn()
    await expect(
      failGuestAnswerAttributionEvaluationRequestAction(
        { ...scope, errorCode: 'UPSTREAM_SECRET_TOKEN' as never },
        { guestAnswerAttributionEvaluationRequest: { updateMany } } as never,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GuestAnswerAttributionEvaluationError>>({
        code: 'INVALID_INPUT',
      }),
    )
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('persists an admitted finite code exactly', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    await expect(
      failGuestAnswerAttributionEvaluationRequestAction(
        { ...scope, errorCode: 'PROVIDER_CONNECTION_FAILED' },
        { guestAnswerAttributionEvaluationRequest: { updateMany } } as never,
      ),
    ).resolves.toBeUndefined()
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastErrorCode: 'PROVIDER_CONNECTION_FAILED' }),
      }),
    )
  })
})

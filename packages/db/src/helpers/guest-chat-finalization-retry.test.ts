import { describe, expect, it, vi } from 'vitest'
import { finalizeGuestChatTurnAction } from './guest-chat-turn-actions'

const input = {
  tenantId: 'fictional-tenant',
  venueId: 'fictional-venue',
  anonymousToken: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  turnId: '33333333-3333-4333-8333-333333333333',
  claimId: '44444444-4444-4444-8444-444444444444',
  visitorId: null,
  message: 'Where is the cafe?',
  language: 'English',
  lat: null,
  lng: null,
  retainLocation: false,
  assistantResponse: 'The cafe is in the atrium.',
  replayMetadata: { places: [], citations: [] },
  fallbackCode: null,
  nextPending: { kind: 'NONE' as const },
}

describe('database-only finalization retry boundary', () => {
  it.each(['P2034', 'P2002'])(
    'retries a rolled-back %s with the same serializable transaction',
    async (code) => {
      const transaction = vi
        .fn()
        .mockRejectedValueOnce({ code })
        .mockResolvedValue({ state: 'COMPLETE' })
      await expect(
        finalizeGuestChatTurnAction({ client: { $transaction: transaction } as never, input }),
      ).resolves.toEqual({ state: 'COMPLETE' })
      expect(transaction).toHaveBeenCalledTimes(2)
      expect(transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'Serializable' })
      expect(transaction.mock.calls[1]?.[1]).toEqual({ isolationLevel: 'Serializable' })
    },
  )
  it('bounds contention retries and exposes no database details', async () => {
    const transaction = vi
      .fn()
      .mockRejectedValue({ code: 'P2034', message: 'private database detail' })
    await expect(
      finalizeGuestChatTurnAction({ client: { $transaction: transaction } as never, input }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Chat turn changed during finalization.' })
    expect(transaction).toHaveBeenCalledTimes(3)
  })
  it.each(['P2028', 'CONFLICT', 'UNKNOWN_PROVIDER_OUTCOME'])(
    'does not retry unknown outcomes or authority failures (%s)',
    async (code) => {
      const error = { code }
      const transaction = vi.fn().mockRejectedValue(error)
      await expect(
        finalizeGuestChatTurnAction({ client: { $transaction: transaction } as never, input }),
      ).rejects.toBe(error)
      expect(transaction).toHaveBeenCalledTimes(1)
    },
  )
})

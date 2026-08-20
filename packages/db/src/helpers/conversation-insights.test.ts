import { describe, expect, it, vi } from 'vitest'

import { recordConversationInsightSignals } from './conversation-insights'

const base = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  sessionId: 'session-a',
  guestChatTurnId: '11111111-1111-4111-8111-111111111111',
  category: 'KNOWLEDGE_GAP' as const,
  confidence: 0.8,
  summary: 'Trusted venue knowledge may not cover this question.',
  capability: 'CLASSIFICATION',
  provider: 'pathfinder',
  model: 'retrieval-confidence-rules',
  analyzerVersion: 'v1',
}

describe('recordConversationInsightSignals', () => {
  it('persists bounded tenant-owned signals with duplicate suppression', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 })
    await expect(
      recordConversationInsightSignals({
        client: { conversationInsight: { createMany } } as never,
        signals: [base],
      }),
    ).resolves.toEqual({ created: 1 })

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          evidenceMessageIds: [],
          severity: 'INFO',
        }),
      ],
      skipDuplicates: true,
    })
  })

  it('rejects out-of-range confidence before persistence', async () => {
    const createMany = vi.fn()
    await expect(
      recordConversationInsightSignals({
        client: { conversationInsight: { createMany } } as never,
        signals: [{ ...base, confidence: 1.1 }],
      }),
    ).rejects.toThrow()
    expect(createMany).not.toHaveBeenCalled()
  })
})

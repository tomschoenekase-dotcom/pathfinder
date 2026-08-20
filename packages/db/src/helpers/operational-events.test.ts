import { describe, expect, it, vi } from 'vitest'

import { publishOperationalEvent } from './operational-events'

describe('publishOperationalEvent', () => {
  it('groups a bounded tenant event by an explicit deduplication key', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'event-1', state: 'OPEN', occurrenceCount: 2 })
    await expect(
      publishOperationalEvent({
        client: { operationalEvent: { upsert } } as never,
        event: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          eventType: 'knowledge.gap.detected',
          sourceSubsystem: 'conversation-intelligence',
          severity: 'WARNING',
          title: 'Possible knowledge gap',
          summary: 'A grounded answer was unavailable.',
          actionRequired: true,
          linkedObjectType: 'guest-chat-turn',
          linkedObjectId: 'turn-1',
          deduplicationKey: 'knowledge-gap:turn-1',
        },
      }),
    ).resolves.toMatchObject({ occurrenceCount: 2 })

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_deduplicationKey: {
            tenantId: 'tenant-1',
            deduplicationKey: 'knowledge-gap:turn-1',
          },
        },
        update: expect.objectContaining({ occurrenceCount: { increment: 1 } }),
      }),
    )
  })

  it('rejects incomplete linked-object references', async () => {
    const upsert = vi.fn()
    await expect(
      publishOperationalEvent({
        client: { operationalEvent: { upsert } } as never,
        event: {
          tenantId: 'tenant-1',
          eventType: 'system.health.issue',
          sourceSubsystem: 'health',
          title: 'Health issue',
          summary: 'A subsystem needs review.',
          linkedObjectType: 'job',
          deduplicationKey: 'health:job',
        },
      }),
    ).rejects.toThrow(/Linked object/u)
    expect(upsert).not.toHaveBeenCalled()
  })
})

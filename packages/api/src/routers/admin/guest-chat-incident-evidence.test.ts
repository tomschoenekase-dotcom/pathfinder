import { describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { readGuestChatIncidentEvidence } from './guest-chat-incident-evidence'
import { adminAttentionConsoleRouter } from './attention-console'
import { router } from '../../core'

const event = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  eventType: 'guest-chat.route-degraded',
  linkedObjectType: 'guest-chat-turn',
  linkedObjectId: '22222222-2222-4222-8222-222222222222',
  occurrenceCount: 3,
  lastOccurredAt: new Date('2026-08-23T16:00:00.000Z'),
}

function deps() {
  return {
    readEvent: vi.fn().mockResolvedValue(event),
    readTurn: vi.fn().mockResolvedValue({
      id: event.linkedObjectId,
      status: 'COMPLETE',
      fallbackCode: 'provider-error',
      completedAt: new Date('2026-08-23T16:00:00.000Z'),
      providerOperations: [
        {
          kind: 'RESPONSE_GENERATION',
          status: 'OBSERVED',
          outcomeCode: 'FAILED_FALLBACK',
          usageReference: 'usage_1',
          dispatchedAt: new Date('2026-08-23T15:59:58.000Z'),
          observedAt: new Date('2026-08-23T15:59:59.000Z'),
        },
      ],
    }),
    readUsage: vi.fn().mockResolvedValue([
      {
        id: 'usage_1',
        capability: 'STANDARD',
        routeModelKey: 'guest-chat',
        fallbackUsed: false,
        provider: 'anthropic',
        model: 'claude-test',
        latencyMs: 812,
        attempts: 1,
        success: false,
        errorCode: 'provider-error',
        createdAt: new Date('2026-08-23T15:59:59.000Z'),
      },
    ]),
    audit: vi.fn().mockResolvedValue(undefined),
  }
}

describe('guest chat incident evidence', () => {
  it('returns exact sanitized latest-turn evidence only after strict audit', async () => {
    const harness = deps()
    const result = await readGuestChatIncidentEvidence(
      { eventId: event.id },
      'operator_1',
      harness as never,
    )

    expect(harness.readTurn).toHaveBeenCalledWith({
      id: event.linkedObjectId,
      tenantId: event.tenantId,
      venueId: event.venueId,
    })
    expect(harness.readUsage).toHaveBeenCalledWith({
      ids: ['usage_1'],
      tenantId: event.tenantId,
      venueId: event.venueId,
    })
    expect(harness.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GUEST_CHAT_INCIDENT_EVIDENCE_READ',
        targetId: event.id,
        afterState: expect.objectContaining({ providerOperationCount: 1, usageEvidenceCount: 1 }),
      }),
    )
    expect(result).toMatchObject({
      effect: 'READ_ONLY',
      event: {
        occurrenceCount: 3,
        latestTurn: {
          fallbackCode: 'provider-error',
          providerOperations: [{ usage: { provider: 'anthropic', success: false } }],
        },
      },
      boundaries: {
        latestOccurrenceOnly: true,
        transcriptIncluded: false,
        providerControlAuthorized: false,
        retryAuthorized: false,
      },
    })
    expect(result.event.latestTurn).not.toHaveProperty('userMessage')
    expect(result.event.latestTurn).not.toHaveProperty('assistantMessage')
    expect(result.event.latestTurn).not.toHaveProperty('replayMetadata')
    expect(result.event.latestTurn.providerOperations[0]).not.toHaveProperty('invocationId')
  })

  it('refuses legacy venue pointers and audit failure', async () => {
    const legacy = deps()
    legacy.readEvent.mockResolvedValue({ ...event, linkedObjectType: 'venue' })
    await expect(
      readGuestChatIncidentEvidence({ eventId: event.id }, 'operator_1', legacy as never),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(legacy.readTurn).not.toHaveBeenCalled()

    const failedAudit = deps()
    failedAudit.audit.mockRejectedValue(new Error('audit unavailable'))
    await expect(
      readGuestChatIncidentEvidence({ eventId: event.id }, 'operator_1', failedAudit as never),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })

  it('rejects non-platform administrators before reading evidence', async () => {
    const testRouter = router({ admin: adminAttentionConsoleRouter })
    const context: TRPCContext = {
      db: {} as TRPCContext['db'],
      headers: new Headers(),
      session: {
        userId: 'user_1',
        activeTenantId: 'tenant_1',
        role: 'OWNER',
        isPlatformAdmin: false,
      },
    }
    await expect(
      testRouter.createCaller(context).admin.guestChatIncidentEvidence({ eventId: event.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

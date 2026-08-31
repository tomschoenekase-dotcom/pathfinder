import { describe, expect, it, vi } from 'vitest'

import {
  claimClientAssistantTurnGenerationAction,
  completeClientAssistantTurnAction,
  linkClientAssistantSupportHandoffAction,
  markClientAssistantTurnProviderDispatchedAction,
  reserveClientAssistantTurnAction,
  setClientAssistantPreferenceAction,
} from './client-assistant-actions'

function client(transaction: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
  }
}

const operationId = 'f5cc4322-b5c1-447d-9b32-1c3e442846b0'
const generationLeaseId = '30591304-803f-4a72-8cc8-fe9fa8d2c989'
const actor = { userId: 'user-1', auditRole: 'OWNER' as const }

describe('client assistant domain actions', () => {
  it('creates a scoped preference at revision one and audits no conversation content', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'member-1' }) },
      clientAssistantPreference: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          enabled: false,
          minimized: false,
          revision: 1,
          updatedAt: new Date('2026-08-19T00:00:00.000Z'),
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const result = await setClientAssistantPreferenceAction(
      {
        tenantId: 'tenant-1',
        enabled: false,
        minimized: false,
        expectedRevision: 0,
        actor,
      },
      client(transaction) as never,
    )
    expect(result).toMatchObject({ enabled: false, revision: 1 })
    expect(transaction.clientAssistantPreference.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-1' }),
      }),
    )
    expect(JSON.stringify(transaction.auditLog.create.mock.calls)).not.toMatch(/message|prompt/iu)
  })

  it('rejects a stale preference revision', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'member-1' }) },
      clientAssistantPreference: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'pref-1',
          enabled: true,
          minimized: false,
          revision: 2,
          updatedAt: new Date(),
        }),
      },
    }
    await expect(
      setClientAssistantPreferenceAction(
        {
          tenantId: 'tenant-1',
          enabled: false,
          minimized: false,
          expectedRevision: 1,
          actor,
        },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('reserves one turn under an authorized tenant venue and serializes sequence allocation', async () => {
    const turn = {
      id: 'turn-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      threadId: 'thread-1',
      operationHash: 'a'.repeat(64),
      status: 'RESERVED',
      behaviorVersion: 'v1',
      userMessage: 'What should I upload?',
      assistantMessage: null,
      questionCategory: null,
      safeActions: [],
      failureCode: null,
      revision: 1,
      createdAt: new Date(),
      completedAt: null,
      thread: { userId: 'user-1' },
    }
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantTurn: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ sequence: 4 }),
        create: vi.fn().mockResolvedValue(turn),
      },
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'member-1' }) },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
      clientAssistantThread: {
        findFirst: vi.fn().mockResolvedValue({ id: 'thread-1' }),
        update: vi.fn().mockResolvedValue({ id: 'thread-1' }),
      },
    }
    const result = await reserveClientAssistantTurnAction(
      {
        operationId,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        behaviorVersion: 'v1',
        userMessage: 'What should I upload?',
        actor,
      },
      client(transaction) as never,
    )
    expect(result).toEqual({ turn, replayed: false })
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(2)
    expect(transaction.clientAssistantTurn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sequence: 5, status: 'RESERVED' }),
      }),
    )
  })

  it('claims generation with a bounded lease and rejects a competing active claim', async () => {
    const now = new Date('2026-08-19T08:00:00.000Z')
    const claimed = {
      id: 'turn-1',
      status: 'GENERATING',
      revision: 2,
      generationLeaseId,
      generationLeaseExpiresAt: new Date(now.getTime() + 30_000),
      generationAttempts: 1,
      providerDispatchedAt: null,
    }
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantTurn: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'turn-1',
          status: 'RESERVED',
          revision: 1,
          generationLeaseId: null,
          generationLeaseExpiresAt: null,
          generationAttempts: 0,
          providerDispatchedAt: null,
        }),
        update: vi.fn().mockResolvedValue(claimed),
      },
    }
    const result = await claimClientAssistantTurnGenerationAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        turnId: 'turn-1',
        generationLeaseId,
        now,
        actor,
      },
      client(transaction) as never,
    )
    expect(result).toEqual({ claim: claimed, replayed: false })
    expect(transaction.clientAssistantTurn.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'GENERATING',
          generationLeaseId,
          generationAttempts: { increment: 1 },
        }),
      }),
    )

    const competing = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantTurn: {
        findFirst: vi.fn().mockResolvedValue({
          ...claimed,
          generationLeaseId: 'd4e16791-331c-44ab-871f-9c16a83d9f0b',
        }),
      },
    }
    await expect(
      claimClientAssistantTurnGenerationAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          turnId: 'turn-1',
          generationLeaseId,
          now,
          actor,
        },
        client(competing) as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('marks provider dispatch only for the active generation claim', async () => {
    const dispatchedAt = new Date('2026-08-19T08:00:01.000Z')
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantTurn: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'turn-1',
          status: 'GENERATING',
          generationLeaseId,
          generationLeaseExpiresAt: new Date('2026-08-19T08:00:30.000Z'),
          providerDispatchedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    await expect(
      markClientAssistantTurnProviderDispatchedAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          turnId: 'turn-1',
          generationLeaseId,
          dispatchedAt,
          actor,
        },
        client(transaction) as never,
      ),
    ).resolves.toEqual({ dispatchedAt, replayed: false })
  })

  it('replays an exact operation without a second membership or provider reservation path', async () => {
    const operationHash = 'b'.repeat(64)
    const replay = {
      id: 'turn-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      threadId: 'thread-1',
      operationHash,
      status: 'COMPLETED',
      behaviorVersion: 'v1',
      userMessage: 'What should I upload?',
      assistantMessage: 'Share what you already have.',
      questionCategory: 'upload-guidance',
      safeActions: [],
      failureCode: null,
      revision: 2,
      createdAt: new Date(),
      completedAt: new Date(),
      generationLeaseId: null,
      thread: { userId: 'user-1' },
    }
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantTurn: { findFirst: vi.fn().mockResolvedValue(replay) },
    }
    const input = {
      operationId,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      behaviorVersion: 'v1',
      userMessage: 'What should I upload?',
      actor,
    }

    // Obtain the canonical hash from a first pass without duplicating private hash logic.
    const firstTransaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantTurn: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        create: vi.fn(async ({ data }) => ({ ...replay, operationHash: data.operationHash })),
      },
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'member-1' }) },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
      clientAssistantThread: {
        findFirst: vi.fn().mockResolvedValue({ id: 'thread-1' }),
        update: vi.fn().mockResolvedValue({ id: 'thread-1' }),
      },
    }
    const first = await reserveClientAssistantTurnAction(input, client(firstTransaction) as never)
    replay.operationHash = first.turn.operationHash
    const result = await reserveClientAssistantTurnAction(input, client(transaction) as never)
    expect(result).toEqual({ turn: replay, replayed: true })
    expect(transaction).not.toHaveProperty('tenantMembership')
  })

  it('completes a generating turn exactly once and accepts only an identical replay', async () => {
    const completed = {
      id: 'turn-1',
      threadId: 'thread-1',
      status: 'COMPLETED',
      revision: 2,
      assistantMessage: 'Open Information.',
      questionCategory: 'portal-navigation',
      safeActions: [{ type: 'navigate', href: '/information' }],
      failureCode: null,
      completedAt: new Date(),
    }
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantTurn: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            ...completed,
            status: 'GENERATING',
            revision: 1,
            assistantMessage: null,
            questionCategory: null,
            safeActions: [],
            completedAt: null,
            generationLeaseId,
          })
          .mockResolvedValueOnce(completed),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      clientAssistantThread: { update: vi.fn().mockResolvedValue({ id: 'thread-1' }) },
    }
    const result = await completeClientAssistantTurnAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        turnId: 'turn-1',
        generationLeaseId,
        expectedRevision: 1,
        assistantMessage: 'Open Information.',
        questionCategory: 'portal-navigation',
        safeActions: [{ type: 'navigate', href: '/information' }],
        outcome: { status: 'COMPLETED' },
        actor,
      },
      client(transaction) as never,
    )
    expect(result).toEqual({ turn: completed, replayed: false })
    expect(transaction.clientAssistantTurn.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revision: 1 }) }),
    )
  })

  it('rejects an unknown terminal failure code before opening a transaction', async () => {
    const dbClient = client({})
    await expect(
      completeClientAssistantTurnAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          turnId: 'turn-1',
          generationLeaseId,
          expectedRevision: 1,
          assistantMessage: 'Please try again later.',
          questionCategory: 'fallback',
          safeActions: [],
          outcome: { status: 'FAILED', failureCode: 'UPSTREAM_SECRET_TOKEN' as never },
          actor,
        },
        dbClient as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(dbClient.$transaction).not.toHaveBeenCalled()
  })

  it('links only a matching completed-turn preview to the client-owned support request', async () => {
    const handoff = {
      id: 'handoff-1',
      operationHash: 'c'.repeat(64),
      turnId: 'turn-1',
      supportRequestId: 'request-1',
      confirmationState: 'CONFIRMED',
      confirmedAt: new Date(),
    }
    const snapshot = {
      schemaVersion: 1 as const,
      source: 'CLIENT_TOCHI' as const,
      category: 'EXPERIENCE_BEHAVIOR' as const,
      summary: 'Review a POS integration',
      requestedOutcome: 'Assess secure ticket purchase support.',
      excerpt: [{ role: 'user' as const, content: 'Can we add POS ticket purchases?' }],
    }
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantSupportHandoff: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(handoff),
      },
      clientAssistantTurn: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'turn-1',
          safeActions: [
            {
              type: 'preview-support-handoff',
              category: snapshot.category,
              summary: snapshot.summary,
              requestedOutcome: snapshot.requestedOutcome,
            },
          ],
        }),
      },
      supportRequest: { findFirst: vi.fn().mockResolvedValue({ id: 'request-1' }) },
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'member-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const result = await linkClientAssistantSupportHandoffAction(
      {
        operationId,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        turnId: 'turn-1',
        supportRequestId: 'request-1',
        summarySnapshot: snapshot,
        actor,
      },
      client(transaction) as never,
    )
    expect(result).toEqual({ handoff, replayed: false })
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'client-assistant.handoff-confirmed' }),
      }),
    )
  })

  it('rejects a handoff when the stored turn did not offer that exact preview', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      clientAssistantSupportHandoff: { findFirst: vi.fn().mockResolvedValue(null) },
      clientAssistantTurn: {
        findFirst: vi.fn().mockResolvedValue({ id: 'turn-1', safeActions: [] }),
      },
      supportRequest: { findFirst: vi.fn().mockResolvedValue({ id: 'request-1' }) },
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'member-1' }) },
    }
    await expect(
      linkClientAssistantSupportHandoffAction(
        {
          operationId,
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          turnId: 'turn-1',
          supportRequestId: 'request-1',
          summarySnapshot: {
            schemaVersion: 1,
            source: 'CLIENT_TOCHI',
            category: 'GENERAL',
            summary: 'Different request',
            requestedOutcome: 'Do something else.',
            excerpt: [],
          },
          actor,
        },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  claimGuestChatTurnAction,
  failGuestChatTurnAction,
  finalizeGuestChatTurnAction,
  guestChatRequestHash,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  reserveGuestChatTurnAction,
} from './guest-chat-turn-actions'

const request = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  anonymousToken: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  visitorId: null,
  message: 'Where is the cafe?',
  language: 'English',
  lat: 41.1,
  lng: -87.2,
  retainLocation: true,
} as const

function transactionClient(tx: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (callback: (value: unknown) => unknown) => callback(tx)),
    guestChatTurn: tx.guestChatTurn,
    guestChatProviderOperation: tx.guestChatProviderOperation,
  } as never
}

describe('guest chat turn actions', () => {
  it('canonicalizes trimmed input and binds every public request field', () => {
    expect(guestChatRequestHash({ ...request, message: '  Where is the cafe?  ' })).toBe(
      guestChatRequestHash(request),
    )
    for (const changed of [
      { venueId: 'venue-2' },
      { anonymousToken: '33333333-3333-4333-8333-333333333333' },
      { visitorId: '44444444-4444-4444-8444-444444444444' },
      { message: 'Where is parking?' },
      { language: 'Español' },
      { lat: 41.2 },
      { lng: -87.3 },
      { retainLocation: false },
    ]) {
      expect(guestChatRequestHash({ ...request, ...changed })).not.toBe(
        guestChatRequestHash(request),
      )
    }
  })

  it('treats an omitted experience scope as public and binds second-layer requests', () => {
    expect(guestChatRequestHash(request)).toBe(
      guestChatRequestHash({ ...request, experienceScope: 'PUBLIC' }),
    )
    expect(guestChatRequestHash({ ...request, experienceScope: 'SECOND_LAYER' })).not.toBe(
      guestChatRequestHash(request),
    )
  })

  it('rejects malformed direct input before opening a transaction', async () => {
    const client = transactionClient({})
    await expect(
      reserveGuestChatTurnAction({ client, request: { ...request, lat: null } as never }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(
      (client as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction,
    ).not.toHaveBeenCalled()
  })

  it('records a strict provider observation with its outcome evidence', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const operation = {
      tenantId: request.tenantId,
      venueId: request.venueId,
      anonymousToken: request.anonymousToken,
      requestId: request.requestId,
      turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      claimId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      kind: 'QUERY_EMBEDDING' as const,
      outcomeCode: 'SUCCEEDED',
      usageReference: null,
    }

    await expect(
      observeGuestChatProviderOperationAction({
        client: { guestChatProviderOperation: { updateMany } } as never,
        operation,
      }),
    ).resolves.toEqual({ observed: true })
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcomeCode: 'SUCCEEDED', usageReference: null }),
      }),
    )
  })

  it('hashes only the reserved request fields while validating finalization', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue({ requestHash: '0'.repeat(64) }),
      },
    }

    await expect(
      finalizeGuestChatTurnAction({
        client: transactionClient(tx),
        input: {
          ...request,
          turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          claimId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          assistantResponse: 'The cafe is downstairs.',
          replayMetadata: { places: [] },
          fallbackCode: null,
          nextPending: { kind: 'NONE' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Finalization request does not match reservation.',
    })
  })

  it('reserves monotonic turn/message sequences and two stable provider receipts atomically', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      visitorSession: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'session-1',
          tenantId: request.tenantId,
          venueId: request.venueId,
          nextTurnSequence: 7,
          nextMessageSequence: 20,
          pendingEngagementQuestionId: null,
          pendingEngagementIsInvented: false,
          pendingEngagementAskedMessageId: null,
          pendingEngagementAskedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        create: vi.fn().mockImplementation(({ data }) => ({
          ...data,
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sessionId: 'session-1',
          providerOperations: data.providerOperations.create,
        })),
      },
      message: { findFirst: vi.fn() },
    }
    const result = await reserveGuestChatTurnAction({ client: transactionClient(tx), request })
    expect(result).toMatchObject({ state: 'RESERVED', sessionId: 'session-1', replayed: false })
    expect(tx.visitorSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextTurnSequence: 8, nextMessageSequence: 22 }),
      }),
    )
    expect(tx.guestChatTurn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestHash: guestChatRequestHash(request),
          turnSequence: 8,
          userMessageSequence: 21,
          assistantMessageSequence: 22,
          providerOperations: {
            create: [
              expect.objectContaining({
                kind: 'QUERY_EMBEDDING',
                invocationId: expect.any(String),
              }),
              expect.objectContaining({
                kind: 'RESPONSE_GENERATION',
                invocationId: expect.any(String),
              }),
            ],
          },
        }),
      }),
    )
  })

  it('terminalizes an expired pre-claim orphan before reserving a new request identity', async () => {
    const newRequest = { ...request, requestId: '99999999-9999-4999-8999-999999999999' }
    const session = {
      id: 'session-1',
      tenantId: request.tenantId,
      venueId: request.venueId,
      nextTurnSequence: 7,
      nextMessageSequence: 20,
      pendingEngagementQuestionId: null,
      pendingEngagementIsInvented: false,
      pendingEngagementAskedMessageId: null,
      pendingEngagementAskedAt: null,
    }
    const tx = {
      $executeRaw: vi.fn(),
      visitorSession: {
        findFirst: vi.fn().mockResolvedValue(session),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      guestChatTurn: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            tenantId: request.tenantId,
            venueId: request.venueId,
            sessionId: session.id,
            requestId: request.requestId,
            requestHash: guestChatRequestHash(request),
            turnSequence: 6,
            status: 'RESERVED',
            leaseToken: null,
            leaseExpiresAt: null,
            userMessageId: null,
            assistantMessageId: null,
            replayMetadata: null,
            responseHash: null,
            failureCode: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            pendingQuestionId: null,
            pendingIsInvented: false,
            pendingAskedMessageId: null,
            pendingAskedAt: null,
            providerOperations: [
              {
                kind: 'QUERY_EMBEDDING',
                status: 'RESERVED',
                invocationId: '66666666-6666-4666-8666-666666666666',
                dispatchedAt: null,
              },
              {
                kind: 'RESPONSE_GENERATION',
                status: 'RESERVED',
                invocationId: '88888888-8888-4888-8888-888888888888',
                dispatchedAt: null,
              },
            ],
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockImplementation(({ data }) => ({
          ...data,
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sessionId: session.id,
          providerOperations: data.providerOperations.create,
        })),
      },
      guestChatProviderOperation: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      message: { findFirst: vi.fn() },
    }
    await expect(
      reserveGuestChatTurnAction({
        client: transactionClient(tx),
        request: newRequest,
        now: new Date('2026-01-01T00:03:00Z'),
      }),
    ).resolves.toMatchObject({ state: 'RESERVED', replayed: false })
    expect(tx.guestChatTurn.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', failureCode: 'ORPHAN_EXPIRED' }),
      }),
    )
    expect(tx.guestChatTurn.create).toHaveBeenCalledOnce()
  })

  it('never reclaims an expired generating turn after any provider dispatch', async () => {
    const tx = {
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId: request.tenantId,
          venueId: request.venueId,
          sessionId: 'session-1',
          requestId: request.requestId,
          requestHash: guestChatRequestHash(request),
          turnSequence: 1,
          status: 'GENERATING',
          leaseToken: '55555555-5555-4555-8555-555555555555',
          leaseExpiresAt: new Date('2026-01-01T00:00:00Z'),
          userMessageId: null,
          assistantMessageId: null,
          replayMetadata: null,
          responseHash: null,
          failureCode: null,
          pendingQuestionId: null,
          pendingIsInvented: false,
          pendingAskedMessageId: null,
          pendingAskedAt: null,
          providerOperations: [
            {
              kind: 'QUERY_EMBEDDING',
              status: 'DISPATCHED',
              invocationId: '66666666-6666-4666-8666-666666666666',
              dispatchedAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        }),
        updateMany: vi.fn(),
      },
    }
    await expect(
      claimGuestChatTurnAction({
        client: transactionClient(tx),
        claim: {
          tenantId: request.tenantId,
          venueId: request.venueId,
          anonymousToken: request.anonymousToken,
          requestId: request.requestId,
          turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          claimId: '77777777-7777-4777-8777-777777777777',
        },
        now: new Date('2026-01-01T00:10:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER_OUTCOME' })
    expect(tx.guestChatTurn.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['zero', []],
    [
      'one',
      [
        {
          kind: 'QUERY_EMBEDDING',
          status: 'RESERVED',
          invocationId: '66666666-6666-4666-8666-666666666666',
          dispatchedAt: null,
        },
      ],
    ],
    [
      'wrong state',
      [
        {
          kind: 'QUERY_EMBEDDING',
          status: 'OBSERVED',
          invocationId: '66666666-6666-4666-8666-666666666666',
          dispatchedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          kind: 'RESPONSE_GENERATION',
          status: 'RESERVED',
          invocationId: '88888888-8888-4888-8888-888888888888',
          dispatchedAt: null,
        },
      ],
    ],
  ])(
    'refuses to claim a reservation with %s provider receipts',
    async (_label, providerOperations) => {
      const tx = {
        guestChatTurn: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            tenantId: request.tenantId,
            venueId: request.venueId,
            sessionId: 'session-1',
            requestId: request.requestId,
            requestHash: guestChatRequestHash(request),
            turnSequence: 1,
            status: 'RESERVED',
            leaseToken: null,
            leaseExpiresAt: null,
            userMessageId: null,
            assistantMessageId: null,
            replayMetadata: null,
            responseHash: null,
            failureCode: null,
            createdAt: new Date(),
            pendingQuestionId: null,
            pendingIsInvented: false,
            pendingAskedMessageId: null,
            pendingAskedAt: null,
            providerOperations,
          }),
          updateMany: vi.fn(),
        },
        guestChatProviderOperation: { updateMany: vi.fn() },
      }
      await expect(
        claimGuestChatTurnAction({
          client: transactionClient(tx),
          claim: {
            tenantId: request.tenantId,
            venueId: request.venueId,
            anonymousToken: request.anonymousToken,
            requestId: request.requestId,
            turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            claimId: '77777777-7777-4777-8777-777777777777',
          },
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|UNKNOWN_PROVIDER_OUTCOME/) })
      expect(tx.guestChatTurn.updateMany).not.toHaveBeenCalled()
    },
  )

  it('claims an undispatched turn and binds both provider receipts to the same lease', async () => {
    const claimId = '77777777-7777-4777-8777-777777777777'
    const tx = {
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId: request.tenantId,
          venueId: request.venueId,
          sessionId: 'session-1',
          requestId: request.requestId,
          requestHash: guestChatRequestHash(request),
          turnSequence: 1,
          status: 'RESERVED',
          leaseToken: null,
          leaseExpiresAt: null,
          userMessageId: null,
          assistantMessageId: null,
          replayMetadata: null,
          responseHash: null,
          failureCode: null,
          pendingQuestionId: null,
          pendingIsInvented: false,
          pendingAskedMessageId: null,
          pendingAskedAt: null,
          providerOperations: [
            {
              kind: 'QUERY_EMBEDDING',
              status: 'RESERVED',
              invocationId: '66666666-6666-4666-8666-666666666666',
              dispatchedAt: null,
            },
            {
              kind: 'RESPONSE_GENERATION',
              status: 'RESERVED',
              invocationId: '88888888-8888-4888-8888-888888888888',
              dispatchedAt: null,
            },
          ],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      guestChatProviderOperation: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    }
    const result = await claimGuestChatTurnAction({
      client: transactionClient(tx),
      claim: {
        tenantId: request.tenantId,
        venueId: request.venueId,
        anonymousToken: request.anonymousToken,
        requestId: request.requestId,
        turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        claimId,
      },
      now: new Date('2026-01-01T00:00:00Z'),
    })
    expect(result).toMatchObject({ state: 'GENERATING', claimId, replayed: false })
    expect(tx.guestChatProviderOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ leaseToken: claimId }),
      }),
    )
  })

  it('cannot classify a dispatched provider operation as a definite pre-dispatch failure', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue({
          sessionId: 'session-1',
          pendingQuestionId: null,
          pendingIsInvented: false,
          pendingAskedMessageId: null,
          pendingAskedAt: null,
          providerOperations: [{ id: 'provider-op-1', status: 'DISPATCHED' }],
        }),
      },
      guestChatProviderOperation: { updateMany: vi.fn() },
      visitorSession: { updateMany: vi.fn() },
    }
    await expect(
      failGuestChatTurnAction({
        client: transactionClient(tx),
        claim: {
          tenantId: request.tenantId,
          venueId: request.venueId,
          anonymousToken: request.anonymousToken,
          requestId: request.requestId,
          turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          claimId: '77777777-7777-4777-8777-777777777777',
          failureCode: 'PROVIDER_REJECTED',
        },
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER_OUTCOME' })
    expect(tx.visitorSession.updateMany).not.toHaveBeenCalled()
  })

  it('fails atomically when prior provider work is observed and later work was never dispatched', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue({
          sessionId: 'session-1',
          pendingQuestionId: 'question-1',
          pendingIsInvented: false,
          pendingAskedMessageId: 'asked-message-1',
          pendingAskedAt: new Date('2026-01-01T00:00:00Z'),
          providerOperations: [
            { id: 'embedding-op', status: 'OBSERVED' },
            { id: 'generation-op', status: 'RESERVED' },
          ],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      guestChatProviderOperation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      visitorSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    await expect(
      failGuestChatTurnAction({
        client: transactionClient(tx),
        claim: {
          tenantId: request.tenantId,
          venueId: request.venueId,
          anonymousToken: request.anonymousToken,
          requestId: request.requestId,
          turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          claimId: '77777777-7777-4777-8777-777777777777',
          failureCode: 'AI_UNAVAILABLE',
        },
      }),
    ).resolves.toEqual({ failed: true })
    expect(tx.visitorSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pendingEngagementQuestionId: 'question-1',
          pendingEngagementAskedMessageId: 'asked-message-1',
        }),
      }),
    )
    expect(tx.guestChatTurn.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
    expect(tx.guestChatProviderOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'RESERVED' }),
        data: expect.objectContaining({
          status: 'CANCELLED',
          outcomeCode: 'AI_UNAVAILABLE',
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      }),
    )
  })

  it('terminalizes an expired dispatched turn on exact retry without redispatching', async () => {
    const expiredTurn = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: request.tenantId,
      venueId: request.venueId,
      sessionId: 'session-1',
      requestId: request.requestId,
      requestHash: guestChatRequestHash(request),
      turnSequence: 1,
      status: 'GENERATING',
      leaseToken: '55555555-5555-4555-8555-555555555555',
      leaseExpiresAt: new Date('2026-01-01T00:01:00Z'),
      userMessageId: null,
      assistantMessageId: null,
      replayMetadata: null,
      responseHash: null,
      failureCode: null,
      pendingQuestionId: null,
      pendingIsInvented: false,
      pendingAskedMessageId: null,
      pendingAskedAt: null,
      providerOperations: [
        {
          kind: 'QUERY_EMBEDDING',
          status: 'DISPATCHED',
          invocationId: '66666666-6666-4666-8666-666666666666',
          dispatchedAt: new Date('2026-01-01T00:00:30Z'),
        },
        {
          kind: 'RESPONSE_GENERATION',
          status: 'RESERVED',
          invocationId: '88888888-8888-4888-8888-888888888888',
          dispatchedAt: null,
        },
      ],
    }
    const tx = {
      $executeRaw: vi.fn(),
      visitorSession: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'session-1',
          tenantId: request.tenantId,
          venueId: request.venueId,
          nextTurnSequence: 1,
          nextMessageSequence: 2,
          pendingEngagementQuestionId: null,
          pendingEngagementIsInvented: false,
          pendingEngagementAskedMessageId: null,
          pendingEngagementAskedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue(expiredTurn),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
      guestChatProviderOperation: {
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }),
      },
      message: { findFirst: vi.fn() },
    }
    await expect(
      reserveGuestChatTurnAction({
        client: transactionClient(tx),
        request,
        now: new Date('2026-01-01T00:02:00Z'),
      }),
    ).resolves.toMatchObject({ state: 'AMBIGUOUS', replayed: true })
    expect(tx.guestChatTurn.create).not.toHaveBeenCalled()
    expect(tx.guestChatTurn.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'AMBIGUOUS' }) }),
    )
  })

  it('terminalizes expired observed-but-unfinalized provider results without changing receipts', async () => {
    const providerUpdates = vi.fn().mockResolvedValue({ count: 0 })
    const tx = {
      $executeRaw: vi.fn(),
      visitorSession: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'session-1',
          tenantId: request.tenantId,
          venueId: request.venueId,
          nextTurnSequence: 1,
          nextMessageSequence: 2,
          pendingEngagementQuestionId: null,
          pendingEngagementIsInvented: false,
          pendingEngagementAskedMessageId: null,
          pendingEngagementAskedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId: request.tenantId,
          venueId: request.venueId,
          sessionId: 'session-1',
          requestId: request.requestId,
          requestHash: guestChatRequestHash(request),
          turnSequence: 1,
          status: 'GENERATING',
          leaseToken: '55555555-5555-4555-8555-555555555555',
          leaseExpiresAt: new Date('2026-01-01T00:01:00Z'),
          userMessageId: null,
          assistantMessageId: null,
          replayMetadata: null,
          responseHash: null,
          failureCode: null,
          pendingQuestionId: null,
          pendingIsInvented: false,
          pendingAskedMessageId: null,
          pendingAskedAt: null,
          providerOperations: [
            {
              kind: 'QUERY_EMBEDDING',
              status: 'OBSERVED',
              invocationId: '66666666-6666-4666-8666-666666666666',
              dispatchedAt: new Date('2026-01-01T00:00:20Z'),
            },
            {
              kind: 'RESPONSE_GENERATION',
              status: 'OBSERVED',
              invocationId: '88888888-8888-4888-8888-888888888888',
              dispatchedAt: new Date('2026-01-01T00:00:40Z'),
            },
          ],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
      guestChatProviderOperation: { updateMany: providerUpdates },
      message: { findFirst: vi.fn() },
    }
    await expect(
      reserveGuestChatTurnAction({
        client: transactionClient(tx),
        request,
        now: new Date('2026-01-01T00:02:00Z'),
      }),
    ).resolves.toMatchObject({ state: 'AMBIGUOUS', replayed: true })
    expect(providerUpdates).toHaveBeenCalledTimes(2)
    expect(tx.guestChatTurn.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'AMBIGUOUS',
          failureCode: 'LEASE_EXPIRED_AFTER_OBSERVED_RESULTS',
        }),
      }),
    )
  })

  it('dispatches with exact claim/scope CAS and refuses a second provider call', async () => {
    const tx = {
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue({
          sessionId: 'session-1',
          leaseExpiresAt: new Date('2026-01-01T00:02:00Z'),
        }),
      },
      guestChatProviderOperation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }
    await expect(
      markGuestChatProviderDispatchedAction({
        client: transactionClient(tx),
        operation: {
          tenantId: request.tenantId,
          venueId: request.venueId,
          anonymousToken: request.anonymousToken,
          requestId: request.requestId,
          turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          claimId: '77777777-7777-4777-8777-777777777777',
          kind: 'RESPONSE_GENERATION',
        },
        now: new Date('2026-01-01T00:01:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER_OUTCOME' })
  })

  it('converges a reservation P2002 through a fresh terminal replay without writes', async () => {
    const response = 'The cafe is beside the lobby.'
    const places: never[] = []
    const responseHash = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(JSON.stringify({ response, places })).digest('hex'),
    )
    const tx = {
      $executeRaw: vi.fn(),
      visitorSession: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'session-1',
          tenantId: request.tenantId,
          venueId: request.venueId,
          nextTurnSequence: 1,
          nextMessageSequence: 2,
          pendingEngagementQuestionId: null,
          pendingEngagementIsInvented: false,
          pendingEngagementAskedMessageId: null,
          pendingEngagementAskedAt: null,
        }),
      },
      guestChatTurn: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId: request.tenantId,
          venueId: request.venueId,
          sessionId: 'session-1',
          requestId: request.requestId,
          requestHash: guestChatRequestHash(request),
          turnSequence: 1,
          status: 'COMPLETE',
          leaseToken: null,
          leaseExpiresAt: null,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
          replayMetadata: { places },
          responseHash,
          failureCode: null,
          pendingQuestionId: null,
          pendingIsInvented: false,
          pendingAskedMessageId: null,
          pendingAskedAt: null,
          providerOperations: [],
        }),
        create: vi.fn(),
      },
      message: { findFirst: vi.fn().mockResolvedValue({ content: response }) },
    }
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockImplementationOnce(async (callback: (value: unknown) => unknown) => callback(tx))
    const result = await reserveGuestChatTurnAction({
      client: {
        $transaction: transaction,
        guestChatTurn: tx.guestChatTurn,
        guestChatProviderOperation: {},
      } as never,
      request,
    })
    expect(result).toMatchObject({
      state: 'COMPLETE',
      userMessageId: 'user-1',
      response,
      replayed: true,
    })
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(tx.guestChatTurn.create).not.toHaveBeenCalled()
  })
})

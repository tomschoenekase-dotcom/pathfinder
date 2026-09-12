import { beforeEach, describe, expect, it, vi } from 'vitest'

const { disposed } = vi.hoisted(() => ({ disposed: vi.fn() }))
vi.mock('./guest-conversation-disposition', () => ({ isGuestConversationDisposed: disposed }))

import {
  claimGuestChatTurnAction,
  failGuestChatTurnAction,
  finalizeGuestChatTurnAction,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  readAdjacentGuestPlaceIdentityPendingAction,
  reserveGuestChatTurnAction,
  skipGuestChatProviderOperationAction,
  type GuestChatTurnActionClient,
} from './guest-chat-turn-actions'

const scope = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  anonymousToken: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
}
const request = {
  ...scope,
  visitorId: null,
  message: 'Synthetic question',
  language: null,
  lat: null,
  lng: null,
  retainLocation: false,
}
const claim = {
  ...scope,
  turnId: '33333333-3333-4333-8333-333333333333',
  claimId: '44444444-4444-4444-8444-444444444444',
}
const operation = { ...claim, kind: 'RESPONSE_GENERATION' as const }
const finalInput = {
  ...request,
  turnId: claim.turnId,
  claimId: claim.claimId,
  assistantResponse: 'Synthetic answer',
  replayMetadata: { places: [] },
  fallbackCode: null,
  nextPending: { kind: 'NONE' as const },
}
function fixture() {
  const models = [
    'visitorSession',
    'guestChatTurn',
    'guestChatProviderOperation',
    'message',
    'engagementQuestion',
    'engagementQuestionResponse',
  ] as const
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    ...Object.fromEntries(
      models.map((model) => [
        model,
        {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          createMany: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      ]),
    ),
  } as { $executeRaw: ReturnType<typeof vi.fn>; $queryRaw: ReturnType<typeof vi.fn> } & Record<
    (typeof models)[number],
    Record<'findFirst' | 'create' | 'createMany' | 'updateMany', ReturnType<typeof vi.fn>>
  >
  const client = {
    ...tx,
    $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)),
  } as unknown as GuestChatTurnActionClient
  return { tx, client, models }
}
const entrypoints: Array<[string, (client: GuestChatTurnActionClient) => Promise<unknown>]> = [
  ['reserve', (client) => reserveGuestChatTurnAction({ client, request })],
  ['claim', (client) => claimGuestChatTurnAction({ client, claim })],
  [
    'adjacent',
    (client) =>
      readAdjacentGuestPlaceIdentityPendingAction({ client, claim, experienceScope: 'PUBLIC' }),
  ],
  ['dispatch', (client) => markGuestChatProviderDispatchedAction({ client, operation })],
  ['skip', (client) => skipGuestChatProviderOperationAction({ client, operation })],
  [
    'observe',
    (client) =>
      observeGuestChatProviderOperationAction({
        client,
        operation: { ...operation, outcomeCode: 'SUCCEEDED' },
      }),
  ],
  [
    'fail',
    (client) =>
      failGuestChatTurnAction({ client, claim: { ...claim, failureCode: 'PRE_DISPATCH_FAILURE' } }),
  ],
  ['finalize', (client) => finalizeGuestChatTurnAction({ client, input: finalInput })],
]

describe('guest action disposition fence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disposed.mockReset().mockResolvedValue(false)
  })
  it.each(['FENCED', 'APPLIED'] as const)(
    'blocks every entrypoint before content lookup or mutation for %s',
    async (state) => {
      // Model the stable DB read seam; native state and digest enforcement are proved separately.
      disposed.mockImplementation(
        async (value) =>
          ['FENCED', 'APPLIED'].includes(state) &&
          value.tenantId === scope.tenantId &&
          value.venueId === scope.venueId &&
          value.anonymousToken === scope.anonymousToken,
      )
      for (const [name, run] of entrypoints) {
        const f = fixture()
        await expect(run(f.client), name).rejects.toMatchObject({
          code: 'SESSION_DISPOSED',
          message: 'This conversation is no longer available.',
        })
        for (const model of f.models)
          for (const fn of Object.values(f.tx[model])) expect(fn, name).not.toHaveBeenCalled()
        expect(disposed).toHaveBeenLastCalledWith(
          {
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            anonymousToken: scope.anonymousToken,
          },
          name === 'observe' ? f.client : f.tx,
        )
      }
    },
  )
  it.each(['claim', 'finalize'] as const)(
    'checks resolved session before %s can inspect a stored hash or replay',
    async (name) => {
      const f = fixture()
      const hashRead = vi.fn(() => {
        throw new Error('Stored hash must not be read')
      })
      f.tx.guestChatTurn.findFirst.mockResolvedValue({
        sessionId: 'session-a',
        get requestHash() {
          return hashRead()
        },
        status: 'COMPLETE',
      })
      disposed.mockImplementation(async (value) => value.sessionId === 'session-a')
      await expect(
        entrypoints.find(([entry]) => entry === name)![1](f.client),
      ).rejects.toMatchObject({ code: 'SESSION_DISPOSED' })
      expect(hashRead).not.toHaveBeenCalled()
      expect(f.tx.message.findFirst).not.toHaveBeenCalled()
      expect(f.tx.message.createMany).not.toHaveBeenCalled()
      expect(f.tx.guestChatTurn.updateMany).not.toHaveBeenCalled()
      expect(f.tx.guestChatTurn.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            session: { anonymousToken: scope.anonymousToken, dispositionOperationId: null },
          }),
        }),
      )
    },
  )
  it('checks adjacent session before loading predecessor content', async () => {
    const f = fixture()
    f.tx.guestChatTurn.findFirst.mockResolvedValue({ sessionId: 'session-a', turnSequence: 2 })
    disposed.mockImplementation(async (value) => value.sessionId === 'session-a')
    await expect(
      readAdjacentGuestPlaceIdentityPendingAction({
        client: f.client,
        claim,
        experienceScope: 'PUBLIC',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_DISPOSED' })
    expect(f.tx.guestChatTurn.findFirst).toHaveBeenCalledTimes(1)
  })
  it.each(['missing', 'foreign-tenant', 'foreign-venue'] as const)(
    'preserves absent/foreign lookup semantics for %s',
    async (kind) => {
      const f = fixture()
      disposed.mockImplementation(
        async (value) => value.tenantId === 'held-tenant' && value.venueId === 'held-venue',
      )
      const selected = {
        ...claim,
        tenantId: kind === 'foreign-tenant' ? 'different-tenant' : scope.tenantId,
        venueId: kind === 'foreign-venue' ? 'different-venue' : scope.venueId,
      }
      await expect(
        claimGuestChatTurnAction({ client: f.client, claim: selected }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(f.tx.guestChatTurn.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: selected.tenantId,
            venueId: selected.venueId,
            session: { anonymousToken: selected.anonymousToken, dispositionOperationId: null },
          }),
        }),
      )
      expect(f.tx.guestChatTurn.updateMany).not.toHaveBeenCalled()
    },
  )
  it('permits a genuinely new token to reserve a distinct visit with stable receipts', async () => {
    const f = fixture()
    const newToken = '55555555-5555-4555-8555-555555555555'
    disposed.mockImplementation(
      async (value) =>
        value.anonymousToken === scope.anonymousToken || value.sessionId === 'old-session',
    )
    f.tx.visitorSession.create.mockResolvedValue({
      id: 'new-session',
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      nextTurnSequence: 0,
      nextMessageSequence: 0,
      pendingEngagementQuestionId: null,
      pendingEngagementIsInvented: false,
      pendingEngagementAskedMessageId: null,
      pendingEngagementAskedAt: null,
    })
    f.tx.guestChatTurn.create.mockResolvedValue({ id: claim.turnId, sessionId: 'new-session' })
    expect(
      await reserveGuestChatTurnAction({
        client: f.client,
        request: { ...request, anonymousToken: newToken },
      }),
    ).toMatchObject({ state: 'RESERVED', sessionId: 'new-session', replayed: false })
    expect(f.tx.visitorSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ anonymousToken: newToken }) }),
    )
    expect(f.tx.guestChatTurn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionId: 'new-session',
          providerOperations: {
            create: [
              expect.objectContaining({ kind: 'QUERY_EMBEDDING' }),
              expect.objectContaining({ kind: 'RESPONSE_GENERATION' }),
            ],
          },
        }),
      }),
    )
  })
})

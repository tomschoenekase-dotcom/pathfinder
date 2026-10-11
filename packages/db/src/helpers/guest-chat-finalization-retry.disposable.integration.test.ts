import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { db } from '../client'
import {
  reserveGuestChatTurnAction,
  claimGuestChatTurnAction,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  finalizeGuestChatTurnAction,
} from './guest-chat-turn-actions'

const enabled =
  process.env.RUN_GUEST_CHAT_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('finalization on disposable PostgreSQL', () => {
  afterAll(async () => {
    await db.$disconnect()
  })
  it('retries a real serialization rollback and commits one message pair with unchanged provider receipts', async () => {
    const suffix = randomUUID()
    const tenant = await db.tenant.create({
      data: { id: `fictional-${suffix}`, name: 'Fictional Museum', slug: `fictional-${suffix}` },
    })
    const venue = await db.venue.create({
      data: { tenantId: tenant.id, name: 'Fictional Museum', slug: `fictional-${suffix}` },
    })
    const request = {
      tenantId: tenant.id,
      venueId: venue.id,
      anonymousToken: randomUUID(),
      requestId: randomUUID(),
      visitorId: null,
      message: 'Where is the cafe?',
      language: 'English',
      lat: null,
      lng: null,
      retainLocation: false,
    }
    const reserved = await reserveGuestChatTurnAction({ request })
    const claim = {
      tenantId: request.tenantId,
      venueId: request.venueId,
      anonymousToken: request.anonymousToken,
      requestId: request.requestId,
      turnId: reserved.turnId,
      claimId: randomUUID(),
    }
    await claimGuestChatTurnAction({ claim })
    for (const kind of ['QUERY_EMBEDDING', 'RESPONSE_GENERATION'] as const) {
      await markGuestChatProviderDispatchedAction({ operation: { ...claim, kind } })
      await observeGuestChatProviderOperationAction({
        operation: { ...claim, kind, outcomeCode: 'SUCCEEDED' },
      })
    }
    const receiptWhere = { tenantId: tenant.id, venueId: venue.id, turnId: reserved.turnId }
    const receipts = await db.guestChatProviderOperation.findMany({
      where: receiptWhere,
      orderBy: { kind: 'asc' },
    })
    let attempts = 0
    let conflicts = 0
    // Interleave a genuine second connection write after the first serializable snapshot.
    // The production transaction and all its writes/rollback remain real PostgreSQL.
    const client = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>, options: object) => {
        attempts += 1
        try {
          return await db.$transaction(async (tx) => {
            const wrapped = new Proxy(tx, {
              get(target, property) {
                if (property !== 'guestChatTurn') return Reflect.get(target, property)
                return new Proxy(tx.guestChatTurn, {
                  get(delegate, method) {
                    if (method !== 'findFirst') return Reflect.get(delegate, method)
                    return async (args: Parameters<typeof tx.guestChatTurn.findFirst>[0]) => {
                      const turn = await tx.guestChatTurn.findFirst(args)
                      if (attempts === 1) {
                        await db.guestChatTurn.updateMany({
                          where: { id: reserved.turnId, tenantId: tenant.id },
                          data: { updatedAt: new Date() },
                        })
                      }
                      return turn
                    }
                  },
                })
              },
            })
            return callback(wrapped)
          }, options)
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034')
            conflicts += 1
          throw error
        }
      },
    }
    const input = {
      ...request,
      ...claim,
      assistantResponse: 'The cafe is in the atrium.',
      replayMetadata: { places: [], citations: [] },
      fallbackCode: null,
      nextPending: { kind: 'NONE' as const },
    }
    const result = await finalizeGuestChatTurnAction({ client: client as never, input })
    expect(conflicts).toBe(1)
    expect(attempts).toBe(2)
    expect(result.state).toBe('COMPLETE')
    const replay = await finalizeGuestChatTurnAction({ input })
    expect(replay).toMatchObject({
      state: 'COMPLETE',
      replayed: true,
      assistantMessageId: result.assistantMessageId,
      userMessageId: result.userMessageId,
    })
    const messages = await db.message.findMany({
      where: { tenantId: tenant.id, guestChatTurnId: reserved.turnId },
      orderBy: { turnMessageSequence: 'asc' },
    })
    expect(messages.map((row) => [row.role, row.content])).toEqual([
      ['user', request.message],
      ['assistant', input.assistantResponse],
    ])
    expect(
      await db.guestChatProviderOperation.findMany({
        where: receiptWhere,
        orderBy: { kind: 'asc' },
      }),
    ).toEqual(receipts)
    expect(
      await db.guestChatTurn.findFirst({ where: { id: reserved.turnId, tenantId: tenant.id } }),
    ).toMatchObject({ status: 'COMPLETE' })
  })
})

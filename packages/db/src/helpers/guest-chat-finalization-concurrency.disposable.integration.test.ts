import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'

import {
  claimGuestChatTurnAction,
  finalizeGuestChatTurnAction,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  reserveGuestChatTurnAction,
  type GuestChatFinalize,
  type GuestChatTurnActionClient,
} from './guest-chat-turn-actions'

const enabled = process.env.RUN_GUEST_CHAT_CONCURRENCY_DB_INTEGRATION === '1'
if (
  enabled &&
  !/^postgres(?:ql)?:\/\/[^/]+@127\.0\.0\.1:\d+\/pathfinder_disposable_(?:answer_attribution_[a-f0-9]{12}|ci)$/u.test(
    process.env.DATABASE_URL ?? '',
  )
) {
  throw new Error(
    'Guest concurrency integration requires the exact loopback disposable attribution or CI database',
  )
}

// a18fde4b and 96cd9084 have the same finalization transaction body. The baseline
// adapter below preserves that real transaction and exposes its first P2034,
// matching a18fde4b's no-P2034-retry behavior without duplicating the SQL body.
describe.skipIf(!enabled)('real PostgreSQL guest finalization concurrency', () => {
  it('compares three bursts of 24 same-venue and 6 second-venue turns before and after retry', async () => {
    const url = new URL(process.env.DATABASE_URL!)
    url.searchParams.set('connection_limit', '40')
    url.searchParams.set('pool_timeout', '40')
    const client = new PrismaClient({
      datasourceUrl: url.toString(),
      log: [{ emit: 'event', level: 'query' }],
    })
    const sqlStatements = new Set<string>()
    client.$on('query', (event) => {
      // Keep SQL templates only. Never retain connection URLs or bound values.
      if (
        /visitor_sessions|guest_chat_turns|guest_conversation_disposition_operations|INSERT INTO.*messages/u.test(
          event.query,
        )
      )
        sqlStatements.add(event.query)
    })
    const reports: unknown[] = []
    try {
      for (const round of [1, 2, 3]) {
        for (const mode of ['baseline-no-retry', 'candidate'] as const) {
          const suffix = randomUUID()
          const tenantId = `synthetic-concurrency-${suffix}`
          const venues = [`fictional-clockwork-${suffix}`, `fictional-orchard-${suffix}`]
          await client.tenant.create({
            data: { id: tenantId, name: 'Fictional concurrency tenant', slug: tenantId },
          })
          for (const [index, venueId] of venues.entries()) {
            await client.venue.create({
              data: {
                id: venueId,
                tenantId,
                name: `Fictional concurrency museum ${index}`,
                slug: venueId,
              },
            })
          }
          const inputs: GuestChatFinalize[] = []
          // Provider evidence is synthetic; no transport or paid API is invoked.
          // Prepare serially so the measured contention is finalization alone.
          for (let index = 0; index < 30; index += 1) {
            const request = {
              tenantId,
              venueId: venues[index < 24 ? 0 : 1]!,
              anonymousToken: randomUUID(),
              requestId: randomUUID(),
              visitorId: null,
              message: `Fictional visitor question ${index}`,
              language: 'English',
              lat: null,
              lng: null,
              retainLocation: false,
              experienceScope: 'PUBLIC' as const,
            }
            const reservation = await reserveGuestChatTurnAction({
              client: client as unknown as GuestChatTurnActionClient,
              request,
            })
            if (reservation.state !== 'RESERVED') throw new Error('Expected fresh reservation')
            const claim = {
              tenantId,
              venueId: request.venueId,
              anonymousToken: request.anonymousToken,
              requestId: request.requestId,
              turnId: reservation.turnId,
              claimId: randomUUID(),
            }
            await claimGuestChatTurnAction({
              client: client as unknown as GuestChatTurnActionClient,
              claim,
            })
            for (const kind of ['QUERY_EMBEDDING', 'RESPONSE_GENERATION'] as const) {
              await markGuestChatProviderDispatchedAction({
                client: client as unknown as GuestChatTurnActionClient,
                operation: { ...claim, kind },
              })
              await observeGuestChatProviderOperationAction({
                client: client as unknown as GuestChatTurnActionClient,
                operation: { ...claim, kind, outcomeCode: 'SYNTHETIC_PROVIDER_DARK' },
              })
            }
            inputs.push({
              ...request,
              turnId: reservation.turnId,
              claimId: claim.claimId,
              assistantResponse: `Frozen fictional answer ${index}`,
              replayMetadata: { places: [], citations: [] },
              fallbackCode: null,
              nextPending: { kind: 'NONE' },
            })
          }

          let arrived = 0
          let predicateLocks: unknown[] = []
          let release!: () => void
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          const barrierTimer = setTimeout(() => release(), 30_000)
          const failures: Array<{
            index: number
            attempt: number
            operation: string
            code: unknown
            message: string
          }> = []
          const attempts = inputs.map(() => 0)
          const started = performance.now()
          const outcomes = await Promise.all(
            inputs.map(async (input, index) => {
              // Instrument real transaction calls; do not replace any database result.
              const instrumented = {
                $transaction: async (
                  body: (tx: unknown) => Promise<unknown>,
                  options: { isolationLevel: string },
                ) => {
                  expect(options.isolationLevel).toBe('Serializable')
                  const attempt = ++attempts[index]!
                  let operation = '$transaction.commit'
                  try {
                    return await client.$transaction(
                      async (tx) => {
                        expect(
                          (
                            await tx.$queryRaw<
                              Array<{ transaction_isolation: string }>
                            >`SHOW transaction_isolation`
                          )[0]?.transaction_isolation,
                        ).toBe('serializable')
                        const wrapped = new Proxy(tx, {
                          get(target, property) {
                            const value = Reflect.get(target, property)
                            if (typeof value === 'function') return value.bind(target)
                            if (!value || typeof value !== 'object' || typeof property !== 'string')
                              return value
                            return new Proxy(value, {
                              get(model, method) {
                                const query = Reflect.get(model, method)
                                if (typeof query !== 'function') return query
                                return async (...args: unknown[]) => {
                                  operation = `${property}.${String(method)}`
                                  if (attempt === 1 && operation === 'message.createMany') {
                                    arrived += 1
                                    if (arrived === inputs.length) {
                                      try {
                                        predicateLocks = await client.$queryRaw<
                                          Array<Record<string, unknown>>
                                        >`
                                  SELECT relation::regclass::text AS relation, mode, page, tuple,
                                    count(*)::int AS holders FROM pg_locks WHERE mode = 'SIReadLock'
                                    GROUP BY relation, mode, page, tuple ORDER BY relation, page, tuple
                                `
                                      } finally {
                                        release()
                                      }
                                    }
                                    await gate
                                  }
                                  return query.apply(model, args)
                                }
                              },
                            })
                          },
                        })
                        const result = await body(wrapped)
                        operation = '$transaction.commit'
                        return result
                      },
                      { isolationLevel: 'Serializable', timeout: 60_000, maxWait: 40_000 },
                    )
                  } catch (error) {
                    const code = (error as { code?: string }).code
                    failures.push({
                      index,
                      attempt,
                      operation,
                      code,
                      message: String((error as Error).message),
                    })
                    if (mode === 'baseline-no-retry' && code === 'P2034') {
                      throw Object.assign(
                        new Error('Baseline exposed rolled-back PostgreSQL serialization failure'),
                        { code: 'BASELINE_P2034', cause: error },
                      )
                    }
                    throw error
                  }
                },
              } as unknown as GuestChatTurnActionClient
              try {
                const result = await finalizeGuestChatTurnAction({ client: instrumented, input })
                return {
                  index,
                  venue: index < 24 ? 'same' : 'second',
                  complete: result.state === 'COMPLETE',
                  code: null,
                }
              } catch (error) {
                return {
                  index,
                  venue: index < 24 ? 'same' : 'second',
                  complete: false,
                  code: (error as { code?: string }).code ?? 'UNKNOWN',
                }
              }
            }),
          )
          clearTimeout(barrierTimer)
          const rows = await client.guestChatTurn.findMany({
            where: { tenantId },
            include: { providerOperations: true },
          })
          const sessions = await client.visitorSession.findMany({ where: { tenantId } })
          const messages = await client.message.findMany({ where: { tenantId } })
          const completed = outcomes.filter((outcome) => outcome.complete).length
          const report = {
            mode,
            round,
            barrierArrivals: arrived,
            elapsedMs: Math.round(performance.now() - started),
            completed,
            failed: outcomes.length - completed,
            attempts,
            outcomes,
            failures,
            predicateLocks,
            sqlStatements: [...sqlStatements],
            invariants: {
              completedRows: rows.filter((row) => row.status === 'COMPLETE').length,
              messages: messages.length,
              observedProviderOperations: rows
                .flatMap((row) => row.providerOperations)
                .filter((row) => row.status === 'OBSERVED').length,
            },
          }
          reports.push(report)
          process.stdout.write(`GUEST_CONCURRENCY_PROOF ${JSON.stringify(report)}\n`)
          expect(arrived).toBe(30)
          expect(messages).toHaveLength(completed * 2)
          expect(rows.filter((row) => row.status === 'COMPLETE')).toHaveLength(completed)
          expect(
            rows.flatMap((row) => row.providerOperations).every((row) => row.status === 'OBSERVED'),
          ).toBe(true)
          for (const outcome of outcomes) {
            const turn = rows.find((row) => row.id === inputs[outcome.index]!.turnId)!
            const turnMessages = messages.filter((row) => row.guestChatTurnId === turn.id)
            expect(turnMessages).toHaveLength(outcome.complete ? 2 : 0)
            expect(sessions.find((session) => session.id === turn.sessionId)?.messageCount).toBe(
              outcome.complete ? 2 : 0,
            )
            if (outcome.complete) {
              const replay = await finalizeGuestChatTurnAction({
                client: client as unknown as GuestChatTurnActionClient,
                input: inputs[outcome.index]!,
              })
              expect(replay.replayed).toBe(true)
              expect(replay.response).toBe(inputs[outcome.index]!.assistantResponse)
            }
          }
          if (mode === 'baseline-no-retry')
            expect(failures.some((failure) => failure.code === 'P2034')).toBe(true)
          else
            expect(completed, `Candidate burst ${round} must finalize all independent turns`).toBe(
              30,
            )
        }
      }
    } finally {
      if (process.env.GUEST_CHAT_CONCURRENCY_REPORT_PATH) {
        writeFileSync(
          process.env.GUEST_CHAT_CONCURRENCY_REPORT_PATH,
          `${JSON.stringify(reports, null, 2)}\n`,
        )
      }
      await client.$disconnect()
    }
  }, 240_000)
})

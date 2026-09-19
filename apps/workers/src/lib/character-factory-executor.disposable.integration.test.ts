import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import {
  handleAgentBridgeHttpRequestCore,
  type AgentBridgeHttpRegistry,
} from '@pathfinder/api/agent-bridge/http-core'
import {
  claimCharacterFactoryJobAction,
  cancelCharacterFactoryJobAction,
  completeCharacterFactoryJobAction,
  db,
  failCharacterFactoryJobAction,
  heartbeatCharacterFactoryJobAction,
  prepareCharacterFactoryJobAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { createAgentBridgeHttpClient, parseAgentBridgeRunnerConfig } from './agent-bridge-runner'
import { runCharacterFactoryExecutor } from './character-factory-executor'

const confirmation = 'pathfinder_disposable_character_factory_executor'
const enabled =
  process.env.RUN_CHARACTER_FACTORY_DB_INTEGRATION === '1' &&
  process.env.PATHFINDER_DISPOSABLE_CHARACTER_FACTORY_CONFIRMATION === confirmation

function assertDisposableBoundary() {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
  const directDatabaseUrl = new URL(process.env.DIRECT_DATABASE_URL ?? '')
  if (
    databaseUrl.toString() !== directDatabaseUrl.toString() ||
    databaseUrl.hostname !== '127.0.0.1' ||
    !databaseUrl.port ||
    !/^\/pathfinder_disposable_character_executor_[a-z0-9_]+$/u.test(databaseUrl.pathname)
  )
    throw new Error('Fixture requires one exact-name disposable IPv4 loopback database.')
}

type CharacterParams = { venueId: string; requestId: string }
type LeasedCharacterParams = CharacterParams & { leaseToken: string }

function asCharacterParams(raw: unknown): CharacterParams {
  if (!raw || typeof raw !== 'object') throw new Error('INVALID_CHARACTER_PARAMS')
  const params = raw as Partial<CharacterParams>
  if (!params.venueId || !params.requestId) throw new Error('INVALID_CHARACTER_PARAMS')
  return { venueId: params.venueId, requestId: params.requestId }
}

function asLeasedCharacterParams(raw: unknown): LeasedCharacterParams {
  const params = asCharacterParams(raw)
  const leaseToken =
    raw && typeof raw === 'object' ? (raw as { leaseToken?: unknown }).leaseToken : undefined
  if (typeof leaseToken !== 'string' || !leaseToken) throw new Error('INVALID_CHARACTER_LEASE')
  return { ...params, leaseToken }
}

/**
 * The HTTP core is real but in-process; this fixture registry deliberately adapts only the canonical
 * DB actions needed by the provider-dark INSPECT journey. It does not emulate a provider
 * or artifact store. CREATE/REVISE artifact verification remains covered by the DB helper.
 */
function fixtureRegistry(tenantId: string, actorId: string): AgentBridgeHttpRegistry {
  const unsupported = () => {
    throw new Error('UNSUPPORTED_FIXTURE_METHOD')
  }
  return new Proxy({} as AgentBridgeHttpRegistry, {
    get: (_target, key) => {
      if (key === 'claimCharacterFactoryJob')
        return (raw: unknown) =>
          claimCharacterFactoryJobAction({ tenantId, ...asCharacterParams(raw) })
      if (key === 'heartbeatCharacterFactoryJob')
        return (raw: unknown) =>
          heartbeatCharacterFactoryJobAction({ tenantId, ...asLeasedCharacterParams(raw) })
      if (key === 'completeCharacterFactoryJob')
        return (raw: unknown) => {
          const input = raw as { resultPayload?: unknown }
          return completeCharacterFactoryJobAction({
            tenantId,
            ...asLeasedCharacterParams(raw),
            resultPayload: input.resultPayload ?? {},
            actor: { type: 'AGENT', id: actorId, role: 'AGENT' },
          })
        }
      if (key === 'failCharacterFactoryJob')
        return (raw: unknown) => {
          const input = raw as { errorCode?: unknown; errorMessage?: unknown }
          if (typeof input.errorCode !== 'string' || typeof input.errorMessage !== 'string')
            throw new Error('INVALID_CHARACTER_FAILURE')
          return failCharacterFactoryJobAction({
            tenantId,
            ...asLeasedCharacterParams(raw),
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            actor: { type: 'AGENT', id: actorId, role: 'AGENT' },
          })
        }
      return unsupported
    },
  })
}

describe.skipIf(!enabled)(
  'character factory executor disposable in-process HTTP-core lifecycle',
  () => {
    afterAll(async () => db.$disconnect())

    it('uses the actual bridge client and HTTP core to claim, fence, and complete one canonical INSPECT job', async () =>
      withTenantIsolationBypass(async () => {
        assertDisposableBoundary()
        const suffix = randomUUID().slice(0, 8)
        const tenantId = `tenant-character-executor-${suffix}`
        const venueId = `venue-character-executor-${suffix}`
        const actorId = `character-executor-${suffix}`
        const requestId = `inspect-${suffix}`
        await db.tenant.create({
          data: { id: tenantId, name: 'Disposable executor tenant', slug: tenantId },
        })
        await db.venue.create({
          data: { id: venueId, tenantId, name: 'Disposable executor venue', slug: venueId },
        })
        const character = await db.customCharacter.create({
          data: {
            tenantId,
            venueId,
            displayName: 'Disposable inspector',
            status: 'REQUESTED',
            createdBy: actorId,
            updatedBy: actorId,
          },
        })
        await prepareCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId,
          action: 'INSPECT',
          requestPayload: {},
          characterId: character.id,
          actor: { type: 'HUMAN', id: actorId, role: 'PLATFORM_ADMIN' },
        })

        const config = parseAgentBridgeRunnerConfig({
          endpoint: 'https://fixture.invalid/agent-bridge',
          secret: `pf_mcp_${'a'.repeat(43)}`,
          venueId,
          provider: 'CODEX_SUBSCRIPTION',
          label: 'Disposable HTTP executor',
          workdir: process.cwd(),
          workerKey: 'character-factory-disposable-fixture',
          taskTimeoutMs: 10_000,
        })
        const fetcher: typeof fetch = async (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          return handleAgentBridgeHttpRequestCore(
            new Request(url, init),
            { tenantId, venueId },
            {
              verify: async () => ({ tenantId, venueId, credentialId: actorId }),
              registry: fixtureRegistry(tenantId, actorId),
              allowAttempt: () => true,
            },
          )
        }
        const call = createAgentBridgeHttpClient(config, fetcher)
        await expect(
          runCharacterFactoryExecutor(
            config,
            { requestId, resultPayload: { inspected: true, providerInvoked: false } },
            new AbortController().signal,
            { call },
          ),
        ).resolves.toMatchObject({
          state: 'completed',
          result: { requestId, venueId, status: 'SUCCEEDED' },
        })
        await expect(
          db.characterFactoryJob.findFirstOrThrow({
            where: { tenantId, venueId, requestId },
            select: { status: true, resultPayload: true, leaseToken: true },
          }),
        ).resolves.toEqual({
          status: 'SUCCEEDED',
          resultPayload: { inspected: true, providerInvoked: false },
          leaseToken: null,
        })

        // A completed request is returned by canonical requesterJob without its lease token.
        await expect(
          runCharacterFactoryExecutor(
            config,
            { requestId, resultPayload: { inspected: true, providerInvoked: false } },
            new AbortController().signal,
            { call },
          ),
        ).resolves.toEqual({ state: 'not-claimed' })

        const cancelledRequestId = `cancel-${suffix}`
        await prepareCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId: cancelledRequestId,
          action: 'INSPECT',
          requestPayload: {},
          characterId: character.id,
          actor: { type: 'HUMAN', id: actorId, role: 'PLATFORM_ADMIN' },
        })
        await cancelCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId: cancelledRequestId,
          actor: { type: 'HUMAN', id: actorId, role: 'PLATFORM_ADMIN' },
        })
        await expect(
          runCharacterFactoryExecutor(
            config,
            { requestId: cancelledRequestId, resultPayload: { shouldNotComplete: true } },
            new AbortController().signal,
            { call },
          ),
        ).resolves.toEqual({ state: 'not-claimed' })
        await expect(
          db.characterFactoryJob.findFirstOrThrow({
            where: { tenantId, venueId, requestId: cancelledRequestId },
            select: { status: true, resultPayload: true },
          }),
        ).resolves.toEqual({ status: 'CANCELLED', resultPayload: null })
      }))
  },
)

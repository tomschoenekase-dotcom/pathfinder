import { beforeEach, describe, expect, it, vi } from 'vitest'

const lease = vi.hoisted(() => vi.fn())
vi.mock('./agent-workflow-run-lease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-workflow-run-lease')>()),
  assertEligibleWorkflowRunLease: lease,
}))

import {
  assertCurrentAgentWorkerClaim,
  type CurrentAgentWorkerClaimInput,
} from './agent-current-worker-claim'

const future = new Date('2030-01-01T00:00:00Z')
const input: CurrentAgentWorkerClaimInput = {
  tenantId: 'tenant',
  clientId: 'tenant',
  venueId: 'venue',
  agentRunId: 'run',
  executionLeaseToken: '11111111-1111-4111-8111-111111111111',
  bridgeSessionId: 'session',
  workerId: 'worker',
  credentialScope: {
    credentialId: 'credential',
    tenantId: 'tenant',
    clientId: 'tenant',
    venueIds: ['venue'],
    capabilities: ['resources:read', 'agent-runs:execute'],
  },
  requiredAgentType: 'CONTENT' as const,
  requiredIdentityCapability: 'intake.read' as const,
  requiredTransportCapabilities: ['resources:read', 'agent-runs:execute'],
}

type Overrides = {
  run?: Record<string, unknown> | null
  identity?: Record<string, unknown> | null
  worker?: Record<string, unknown> | null
  credential?: Record<string, unknown> | null
  session?: Record<string, unknown> | null
  now?: unknown
}

function transaction(overrides: Overrides = {}) {
  const order: string[] = []
  const rows = {
    run:
      overrides.run === null
        ? []
        : [
            {
              id: 'run',
              agentIdentityId: 'identity',
              executionWorkerId: 'worker',
              executionBridgeSessionId: 'session',
              executionLeaseExpiresAt: future,
              cancelRequestedAt: null,
              ...overrides.run,
            },
          ],
    identity: overrides.identity === null ? [] : [{ id: 'identity', ...overrides.identity }],
    worker:
      overrides.worker === null
        ? []
        : [
            {
              id: 'worker',
              credentialId: 'credential',
              credentialScopeKey: 'venue',
              leaseExpiresAt: future,
              capabilities: ['resources:read', 'agent-runs:execute'],
              agentRoles: ['CONTENT'],
              ...overrides.worker,
            },
          ],
    credential:
      overrides.credential === null
        ? []
        : [
            {
              id: 'credential',
              scopeKey: 'venue',
              expiresAt: future,
              capabilities: ['resources:read', 'agent-runs:execute'],
              ...overrides.credential,
            },
          ],
    session:
      overrides.session === null
        ? []
        : [{ id: 'session', expiresAt: future, ...overrides.session }],
  }
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?')
      if (sql.includes('FROM agent_runs')) {
        order.push('run')
        return rows.run
      }
      if (sql.includes('FROM agent_identities')) {
        order.push('identity')
        return rows.identity
      }
      if (sql.includes('FROM agent_workers')) {
        order.push('worker')
        return rows.worker
      }
      if (sql.includes('FROM external_access_credentials')) {
        order.push('credential')
        return rows.credential
      }
      if (sql.includes('FROM agent_bridge_sessions')) {
        order.push('session')
        return rows.session
      }
      if (sql.includes('clock_timestamp()')) {
        order.push('clock')
        return [{ now: overrides.now ?? new Date('2029-01-01T00:00:00Z') }]
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    }),
  }
  return { tx, order }
}

beforeEach(() => {
  vi.clearAllMocks()
  lease.mockResolvedValue({ bindings: [] })
})

describe('current agent worker claim', () => {
  it('checks the workflow lease first, locks authority in order, then uses one final clock', async () => {
    const { tx, order } = transaction()
    lease.mockImplementation(async () => order.push('workflow'))
    await expect(assertCurrentAgentWorkerClaim(tx as never, input)).resolves.toEqual({
      agentIdentityId: 'identity',
      workerId: 'worker',
      credentialId: 'credential',
      bridgeSessionId: 'session',
    })
    expect(order).toEqual([
      'workflow',
      'run',
      'identity',
      'worker',
      'credential',
      'session',
      'clock',
    ])
    expect(lease).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: 'tenant',
        venueId: 'venue',
        agentRunId: 'run',
        executionLeaseToken: input.executionLeaseToken,
      }),
    )
  })

  it.each([
    ['wrong assigned worker', { run: { executionWorkerId: 'other' } }],
    ['wrong assigned session', { run: { executionBridgeSessionId: 'other' } }],
    ['cancelled run', { run: { cancelRequestedAt: new Date() } }],
    ['disabled or wrong identity', { identity: null }],
    ['wrong worker role', { worker: { agentRoles: ['MEDIA'] } }],
    ['offline worker', { worker: null }],
    ['wrong credential', { credential: null }],
    ['wrong credential scope', { credential: { scopeKey: 'other' } }],
    ['wrong session credential or scope', { session: null }],
  ] as const)('rejects %s', async (_label, overrides) => {
    await expect(
      assertCurrentAgentWorkerClaim(transaction(overrides).tx as never, input),
    ).rejects.toMatchObject({ code: 'CURRENT_AGENT_WORKER_CLAIM_DENIED' })
  })

  it.each([
    ['run', { run: { executionLeaseExpiresAt: new Date('2029-01-01T00:00:00Z') } }],
    ['worker', { worker: { leaseExpiresAt: new Date('2029-01-01T00:00:00Z') } }],
    ['credential', { credential: { expiresAt: new Date('2029-01-01T00:00:00Z') } }],
    ['session', { session: { expiresAt: new Date('2029-01-01T00:00:00Z') } }],
  ] as const)('rejects an expired %s at the final database clock', async (_label, overrides) => {
    await expect(
      assertCurrentAgentWorkerClaim(transaction(overrides).tx as never, input),
    ).rejects.toThrow('expired before admission')
  })

  it('rejects malformed final database time', async () => {
    await expect(
      assertCurrentAgentWorkerClaim(transaction({ now: new Date(Number.NaN) }).tx as never, input),
    ).rejects.toThrow('expired before admission')
  })

  it.each([
    ['tenant mismatch', { tenantId: 'other' }],
    ['client mismatch', { clientId: 'other' }],
    ['venue mismatch', { venueIds: ['other'] }],
    ['missing verified capability', { capabilities: ['resources:read'] }],
  ])('rejects verified credential %s before database admission', async (_label, scopeOverride) => {
    const { tx } = transaction()
    await expect(
      assertCurrentAgentWorkerClaim(tx as never, {
        ...input,
        credentialScope: { ...input.credentialScope, ...scopeOverride } as never,
      }),
    ).rejects.toBeDefined()
    expect(lease).not.toHaveBeenCalled()
  })

  it.each([
    ['worker credential', { worker: { credentialId: 'other' } }],
    ['worker capability', { worker: { capabilities: ['resources:read'] } }],
    ['credential capability', { credential: { capabilities: ['resources:read'] } }],
  ] as const)('rejects a missing current %s', async (_label, overrides) => {
    await expect(
      assertCurrentAgentWorkerClaim(transaction(overrides).tx as never, input),
    ).rejects.toMatchObject({ code: 'CURRENT_AGENT_WORKER_CLAIM_DENIED' })
  })
})

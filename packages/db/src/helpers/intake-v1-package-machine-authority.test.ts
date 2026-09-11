import { beforeEach, describe, expect, it, vi } from 'vitest'

const lease = vi.hoisted(() => vi.fn())
vi.mock('./agent-workflow-run-lease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-workflow-run-lease')>()),
  assertEligibleWorkflowRunLease: lease,
}))
import { assertIntakeV1PackageMachineAuthority } from './intake-v1-package-machine-authority'

const input = {
  tenantId: 'tenant',
  clientId: 'tenant',
  venueId: 'venue',
  agentIdentityId: 'identity',
  agentRunId: 'run',
  workerKey: 'worker',
  credentialId: 'credential',
  capability: 'packages:draft',
  executionLeaseToken: '11111111-1111-4111-8111-111111111111',
}

function client(
  overrides: { worker?: boolean; credential?: boolean; expiry?: Date; clocks?: unknown[] } = {},
) {
  const future = overrides.expiry ?? new Date(Date.now() + 60_000)
  const clocks = overrides.clocks ?? [new Date(), new Date()]
  const rows = [
    [{ id: 'identity' }],
    [
      overrides.worker === false
        ? undefined
        : { id: 'worker-id', leaseExpiresAt: future, credentialScopeKey: 'scope' },
    ].filter(Boolean),
    [
      overrides.credential === false
        ? undefined
        : { id: 'credential', expiresAt: future, scopeKey: 'scope' },
    ].filter(Boolean),
    ...clocks.map((now) => (now === undefined ? [] : [{ now }])),
  ]
  return {
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'run',
        executionWorkerId: 'worker-id',
        executionLeaseExpiresAt: future,
        cancelRequestedAt: null,
      }),
    },
    $queryRaw: vi.fn().mockImplementation(() => Promise.resolve(rows.shift() ?? [])),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  lease.mockResolvedValue(undefined)
})
describe('V1 machine authority', () => {
  it('binds the run-assigned worker and supports a post-wait expiry recheck', async () => {
    const tx = client()
    const authority = await assertIntakeV1PackageMachineAuthority(tx as never, input)
    await expect(authority.recheckTime()).resolves.toBeInstanceOf(Date)
    expect(lease).toHaveBeenCalledWith(tx, expect.objectContaining({ agentRunId: 'run' }))
  })
  it('does not narrow a workflow that requires additional current capabilities', async () => {
    lease.mockImplementation(async (_tx, request: Record<string, unknown>) => {
      if ('availableCapabilities' in request)
        throw new Error('caller narrowed workflow capabilities')
    })
    await expect(
      assertIntakeV1PackageMachineAuthority(client() as never, input),
    ).resolves.toBeDefined()
    expect(lease).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ availableCapabilities: expect.anything() }),
    )
  })
  it.each([
    ['missing', undefined],
    ['invalid', new Date(Number.NaN)],
  ])('fails closed when the database clock is %s', async (_label, now) => {
    await expect(
      assertIntakeV1PackageMachineAuthority(client({ clocks: [now] }) as never, input),
    ).rejects.toThrow('expired before the effect')
  })
  it('rejects when authority expires while finalization waits', async () => {
    const expiry = new Date(Date.now() + 30_000)
    const tx = client({
      expiry,
      clocks: [new Date(expiry.getTime() - 1), new Date(expiry.getTime() + 1)],
    })
    const authority = await assertIntakeV1PackageMachineAuthority(tx as never, input)
    await expect(authority.recheckTime()).rejects.toThrow('expired before the effect')
  })
  it('rejects revoked credentials and mismatched assigned workers', async () => {
    await expect(
      assertIntakeV1PackageMachineAuthority(client({ credential: false }) as never, input),
    ).rejects.toThrow('unavailable')
    await expect(
      assertIntakeV1PackageMachineAuthority(client({ worker: false }) as never, input),
    ).rejects.toThrow('unavailable')
  })
})

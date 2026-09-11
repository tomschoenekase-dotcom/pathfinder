import { beforeEach, describe, expect, it, vi } from 'vitest'
const { leaseGuard } = vi.hoisted(() => ({ leaseGuard: vi.fn() }))
vi.mock('@pathfinder/db', () => ({ assertEligibleWorkflowRunLease: leaseGuard }))
import { assertMcpWorkflowEffectLease, assertMcpWorkflowToolSupported } from './workflow-boundary'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a', agentRunId: 'run-a' }
const effectiveBinding = { outcome: { in: ['SELECTED', 'CANARY_SKIPPED_PRIOR_VERSION'] } }
const token = '00000000-0000-4000-8000-000000000001'
describe('MCP workflow effect boundary', () => {
  beforeEach(() => {
    leaseGuard.mockReset()
  })
  it('keeps unbound legacy requests compatible without deriving a lease', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    await assertMcpWorkflowEffectLease({ agentWorkflowRunBinding: { findFirst } } as never, scope)
    expect(findFirst).toHaveBeenCalledWith({
      where: { ...scope, ...effectiveBinding },
      select: { id: true },
    })
    expect(leaseGuard).not.toHaveBeenCalled()
  })
  it('rejects a bound request without the caller token', async () => {
    const tx = {
      agentWorkflowRunBinding: { findFirst: vi.fn().mockResolvedValue({ id: 'binding' }) },
    }
    await expect(assertMcpWorkflowEffectLease(tx as never, scope)).rejects.toThrow(
      'caller execution lease',
    )
    expect(leaseGuard).not.toHaveBeenCalled()
  })
  it('passes the same effect transaction and exact caller token to the canonical guard', async () => {
    const tx = {
      agentWorkflowRunBinding: { findFirst: vi.fn().mockResolvedValue({ id: 'binding' }) },
    }
    await assertMcpWorkflowEffectLease(tx as never, {
      ...scope,
      executionLeaseToken: token,
      availableCapabilities: ['updates:draft'],
    })
    expect(leaseGuard).toHaveBeenCalledWith(tx, {
      ...scope,
      executionLeaseToken: token,
      actionClass: 'APPROVAL_BACKED_DOMAIN_EFFECT',
      availableCapabilities: ['updates:draft'],
    })
  })
  it('propagates revocation and stale-lease rejection before the effect can proceed', async () => {
    const tx = {
      agentWorkflowRunBinding: { findFirst: vi.fn().mockResolvedValue({ id: 'binding' }) },
    }
    const effect = vi.fn()
    leaseGuard.mockRejectedValue(new Error('LEASE_LOST'))
    await expect(
      (async () => {
        await assertMcpWorkflowEffectLease(tx as never, { ...scope, executionLeaseToken: token })
        effect()
      })(),
    ).rejects.toThrow('LEASE_LOST')
    expect(effect).not.toHaveBeenCalled()
  })
})

describe('MCP unsupported workflow effects', () => {
  const context = { credential: { tenantId: 'tenant-a', venueIds: ['venue-a'] } } as never
  it('denies an unsupported attributed write for a bound run', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'binding' })
    await expect(
      assertMcpWorkflowToolSupported(
        { agentWorkflowRunBinding: { findFirst } } as never,
        'pathfinder.open_support_request',
        { agentRunId: 'run-a', venueId: 'venue-a' },
        context,
      ),
    ).rejects.toThrow('does not support workflow-bound')
    expect(findFirst).toHaveBeenCalledWith({
      where: { ...scope, ...effectiveBinding },
      select: { id: true },
    })
  })
  it('preserves an unbound write and limits venue-unspecified lookup to credential venues', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    await assertMcpWorkflowToolSupported(
      { agentWorkflowRunBinding: { findFirst } } as never,
      'torchiko.meeting.process',
      { agentRunId: 'run-a' },
      context,
    )
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        agentRunId: 'run-a',
        venueId: { in: ['venue-a'] },
        ...effectiveBinding,
      },
      select: { id: true },
    })
  })
  it('leaves read tools and separately transaction-fenced writes to their canonical actions', async () => {
    const findFirst = vi.fn()
    for (const name of ['pathfinder.read', 'pathfinder.create_support_draft']) {
      await assertMcpWorkflowToolSupported(
        { agentWorkflowRunBinding: { findFirst } } as never,
        name,
        { agentRunId: 'run-a', venueId: 'venue-a' },
        context,
      )
    }
    expect(findFirst).not.toHaveBeenCalled()
  })
})

it('leaves specialist delegation to its canonical transaction fence', async () => {
  const findFirst = vi.fn().mockResolvedValue({ id: 'binding' })
  await assertMcpWorkflowToolSupported(
    { agentWorkflowRunBinding: { findFirst } } as never,
    'pathfinder.delegate_specialist',
    { parentAgentRunId: 'run-a', venueId: 'venue-a' },
    { credential: { tenantId: 'tenant-a', venueIds: ['venue-a'] } } as never,
  )
  expect(findFirst).not.toHaveBeenCalled()
})

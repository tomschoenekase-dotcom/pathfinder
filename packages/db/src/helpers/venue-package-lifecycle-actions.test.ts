import { describe, expect, it, vi } from 'vitest'

import {
  approveVenuePackageAction,
  applyVenuePackageAction,
  revertVenuePackageAction,
  VenuePackageLifecycleError,
} from './venue-package-lifecycle-actions'

const revision = new Date('2026-08-11T14:30:00.000Z')
const actor = { type: 'HUMAN', id: 'owner-1', role: 'OWNER' } as const
const agentActor = {
  type: 'AGENT',
  actorId: 'agent-1',
  role: 'AGENT',
  agentIdentityId: 'agent-1',
  agentRunId: 'run-1',
  workerId: 'worker-1',
  credentialId: 'credential-1',
  approvalGrantId: 'grant-1',
  capability: 'packages:apply',
  idempotencyKey: 'command-1',
} as const
const reversionAgentActor = {
  ...agentActor,
  capability: 'packages:revert',
} as const

function record(status: string): {
  id: string
  tenantId: string
  venueId: string
  status: string
  updatedAt: Date
  approvedCommandKey: string | null
  approvedBy: string | null
  appliedCommandKey: string | null
  appliedBy: string | null
  revertedCommandKey: string | null
  revertedBy: string | null
} {
  return {
    id: 'package-1',
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    status,
    updatedAt: revision,
    approvedCommandKey: null,
    approvedBy: null,
    appliedCommandKey: null,
    appliedBy: null,
    revertedCommandKey: null,
    revertedBy: null,
  }
}

function fixture(rows: Array<ReturnType<typeof record> | null>) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    venuePackage: { updateMany: vi.fn(async () => ({ count: 1 })) },
    auditLog: {
      create: vi.fn(async (input: unknown) => {
        void input
        return {}
      }),
    },
    onboardingMilestoneEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => data),
    },
  }
  const load = vi.fn(async () => rows.shift() ?? null)
  const client = { $transaction: vi.fn(async (callback) => callback(tx)) }
  return { tx, load, client }
}

const auditState = (value: ReturnType<typeof record>) => ({ id: value.id, status: value.status })
const validate = vi.fn(async () => undefined)

describe('venue package lifecycle actions', () => {
  it.each([
    ['approve', approveVenuePackageAction, 'DRAFT', 'APPROVED'],
    ['apply', applyVenuePackageAction, 'APPROVED', 'APPLIED'],
    ['revert', revertVenuePackageAction, 'APPLIED', 'REVERTED'],
  ] as const)(
    '%s owns lock, exact CAS, transition, and strict audit',
    async (_name, action, beforeStatus, afterStatus) => {
      const before = record(beforeStatus)
      const after = { ...record(afterStatus), updatedAt: new Date(revision.getTime() + 1) }
      const { tx, load, client } = fixture([before, before, after])
      const execute = vi.fn(async () => ({ evidence: 'bounded' }))
      await action(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor,
          load,
          validate,
          execute,
          auditState,
        },
        client as never,
      )
      expect(tx.venuePackage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'package-1',
            tenantId: 'tenant-1',
            venueId: 'venue-1',
            status: beforeStatus,
            updatedAt: revision,
          },
          data: expect.objectContaining({ status: afterStatus, evidence: 'bounded' }),
        }),
      )
      expect(tx.auditLog.create).toHaveBeenCalledOnce()
      expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('body')
      expect(tx.onboardingMilestoneEvent.create).toHaveBeenCalledTimes(
        afterStatus === 'APPROVED' ? 0 : 1,
      )
    },
  )

  it('replays only the matching command key without effects, transition, or duplicate audit', async () => {
    const replay = {
      ...record('APPROVED'),
      approvedCommandKey: 'command-1',
      approvedBy: actor.id,
    }
    const { tx, load, client } = fixture([replay, replay])
    const execute = vi.fn(async () => ({}))
    await expect(
      approveVenuePackageAction(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor,
          load,
          validate,
          execute,
          auditState,
        },
        client as never,
      ),
    ).resolves.toEqual(replay)
    expect(execute).not.toHaveBeenCalled()
    expect(tx.venuePackage.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects a matching command key owned by another actor', async () => {
    const replay = {
      ...record('APPROVED'),
      approvedCommandKey: 'command-1',
      approvedBy: 'owner-2',
    }
    const { tx, load, client } = fixture([replay, replay])
    await expect(
      approveVenuePackageAction(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor,
          load,
          validate,
          auditState,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<VenuePackageLifecycleError>)
    expect(tx.venuePackage.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('permits an explicit HUMAN platform administrator and audits that exact role', async () => {
    const before = record('DRAFT')
    const after = {
      ...record('APPROVED'),
      approvedBy: 'operator-1',
      updatedAt: new Date(revision.getTime() + 1),
    }
    const { tx, load, client } = fixture([before, before, after])
    await approveVenuePackageAction(
      {
        tenantId: 'tenant-1',
        id: 'package-1',
        expectedUpdatedAt: revision,
        commandKey: 'command-1',
        actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
        load,
        validate,
        auditState,
      },
      client as never,
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorRole: 'PLATFORM_ADMIN' }) }),
    )
  })

  it('permits a fully verified packages:apply agent for apply only and preserves lineage', async () => {
    const before = record('APPROVED')
    const after = {
      ...record('APPLIED'),
      appliedBy: agentActor.actorId,
      updatedAt: new Date(revision.getTime() + 1),
    }
    const { tx, load, client } = fixture([before, before, after])
    await applyVenuePackageAction(
      {
        tenantId: 'tenant-1',
        id: 'package-1',
        expectedUpdatedAt: revision,
        commandKey: 'command-1',
        actor: agentActor,
        load,
        validate,
        auditState,
      },
      client as never,
    )
    expect(tx.venuePackage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ appliedBy: 'agent-1', status: 'APPLIED' }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'AGENT',
          actorId: 'agent-1',
          actorRole: 'AGENT',
          agentIdentityId: 'agent-1',
          agentRunId: 'run-1',
          workerId: 'worker-1',
          credentialId: 'credential-1',
          approvalGrantId: 'grant-1',
          capability: 'packages:apply',
          idempotencyKey: 'command-1',
        }),
      }),
    )
    expect(tx.onboardingMilestoneEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorType: 'AGENT' }) }),
    )
  })

  it('permits a fully verified packages:revert agent for reversion only and preserves lineage', async () => {
    const before = record('APPLIED')
    const after = {
      ...record('REVERTED'),
      revertedBy: reversionAgentActor.actorId,
      updatedAt: new Date(revision.getTime() + 1),
    }
    const { tx, load, client } = fixture([before, before, after])
    await revertVenuePackageAction(
      {
        tenantId: 'tenant-1',
        id: 'package-1',
        expectedUpdatedAt: revision,
        commandKey: 'command-1',
        actor: reversionAgentActor,
        load,
        validate,
        auditState,
      },
      client as never,
    )
    expect(tx.venuePackage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revertedBy: 'agent-1', status: 'REVERTED' }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'AGENT',
          capability: 'packages:revert',
          approvalGrantId: 'grant-1',
          idempotencyKey: 'command-1',
        }),
      }),
    )
  })

  it.each([
    ['approve', approveVenuePackageAction],
    ['revert', revertVenuePackageAction],
  ] as const)('rejects an agent for %s even with apply authority', async (_kind, action) => {
    const { client, load } = fixture([])
    await expect(
      action(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor: agentActor,
          load,
          validate,
          auditState,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<VenuePackageLifecycleError>)
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...agentActor, capability: 'packages:approve' }, 'wrong capability'],
    [{ ...agentActor, approvalGrantId: undefined }, 'missing grant'],
    [{ ...agentActor, idempotencyKey: undefined }, 'missing idempotency lineage'],
    [{ ...agentActor, idempotencyKey: 'another-command' }, 'mismatched idempotency lineage'],
  ] as const)('rejects agent apply with %s (%s)', async (invalidActor, label) => {
    void label
    const { client, load } = fixture([])
    await expect(
      applyVenuePackageAction(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor: invalidActor as never,
          load,
          validate,
          auditState,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<VenuePackageLifecycleError>)
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('fails closed for cross-tenant records before lock or validation', async () => {
    const foreign = { ...record('DRAFT'), tenantId: 'tenant-2' }
    const { tx, load, client } = fixture([foreign])
    const crossTenantValidate = vi.fn(async () => undefined)
    await expect(
      approveVenuePackageAction(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor,
          load,
          validate: crossTenantValidate,
          auditState,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<VenuePackageLifecycleError>)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6) // content-version context only; no venue lock
    expect(crossTenantValidate).not.toHaveBeenCalled()
  })

  it('requires a human OWNER before opening a transaction', async () => {
    const { client, load } = fixture([])
    await expect(
      approveVenuePackageAction(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor: { ...actor, role: 'MANAGER' } as never,
          load,
          validate,
          auditState,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<VenuePackageLifecycleError>)
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('fails a stale revision without writing an audit record', async () => {
    const before = record('DRAFT')
    const { tx, load, client } = fixture([before, before])
    tx.venuePackage.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(
      approveVenuePackageAction(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor,
          load,
          validate,
          auditState,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<VenuePackageLifecycleError>)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('propagates strict audit persistence failure from the transaction', async () => {
    const before = record('DRAFT')
    const after = { ...record('APPROVED'), updatedAt: new Date(revision.getTime() + 1) }
    const { tx, load, client } = fixture([before, before, after])
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      approveVenuePackageAction(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor,
          load,
          validate,
          auditState,
        },
        client as never,
      ),
    ).rejects.toThrow('audit unavailable')
  })

  it.each([
    ['approve', approveVenuePackageAction, 'DRAFT'],
    ['apply', applyVenuePackageAction, 'APPROVED'],
    ['revert', revertVenuePackageAction, 'APPLIED'],
  ] as const)(
    'maps a %s command-key collision to a domain conflict',
    async (_name, action, status) => {
      const before = record(status)
      const { tx, load, client } = fixture([before, before])
      tx.venuePackage.updateMany.mockRejectedValueOnce({ code: 'P2002' })

      await expect(
        action(
          {
            tenantId: 'tenant-1',
            id: 'package-1',
            expectedUpdatedAt: revision,
            commandKey: 'command-used-by-another-package',
            actor,
            load,
            validate,
            auditState,
          },
          client as never,
        ),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Venue-package command key was already used',
      } satisfies Partial<VenuePackageLifecycleError>)
      expect(tx.auditLog.create).not.toHaveBeenCalled()
    },
  )

  it('converges a P2002 to an exact actor-bound replay on a fresh transaction', async () => {
    const before = record('DRAFT')
    const replay = {
      ...record('APPROVED'),
      approvedCommandKey: 'command-1',
      approvedBy: actor.id,
    }
    const first = fixture([before, before])
    first.tx.venuePackage.updateMany.mockRejectedValueOnce({ code: 'P2002' })
    const secondTx = fixture([replay]).tx
    const client = {
      $transaction: vi
        .fn()
        .mockImplementationOnce(async (callback) => callback(first.tx))
        .mockImplementationOnce(async (callback) => callback(secondTx)),
    }
    const load = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(replay)
    await expect(
      approveVenuePackageAction(
        {
          tenantId: 'tenant-1',
          id: 'package-1',
          expectedUpdatedAt: revision,
          commandKey: 'command-1',
          actor,
          load,
          validate,
          auditState,
        },
        client as never,
      ),
    ).resolves.toEqual(replay)
    expect(client.$transaction).toHaveBeenCalledTimes(2)
    expect(first.tx.auditLog.create).not.toHaveBeenCalled()
    expect(secondTx.auditLog.create).not.toHaveBeenCalled()
  })
})

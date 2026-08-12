import { beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => vi.fn())
vi.mock('./audit', () => ({ writeAuditLogStrict: audit }))

import {
  linkSupportRequestAgentRunAction,
  SupportAgentRunLineageError,
} from './support-agent-run-lineage'

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  agentRunId: 'run_1',
  expectedVersion: 4,
  actor: { actorType: 'HUMAN', actorId: 'admin_1', auditRole: 'PLATFORM_ADMIN' },
} as const

function harness() {
  const lineage = {
    id: 'lineage_1',
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    supportRequestId: 'request_1',
    requestVersion: 4,
    agentRunId: 'run_1',
    linkedRunStatus: 'COMPLETED',
    linkedRunCompletedAt: new Date('2026-08-12T11:59:00.000Z'),
    linkedByKind: 'OPERATOR',
    linkedById: 'admin_1',
    linkedByRole: 'PLATFORM_ADMIN',
    createdAt: new Date('2026-08-12T12:00:00.000Z'),
  }
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: 'request_1', status: 'IN_REVIEW', version: 4 }),
    },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'run_1',
        status: 'COMPLETED',
        agentIdentityId: 'agent_1',
        completedAt: new Date('2026-08-12T11:59:00.000Z'),
      }),
    },
    supportRequestAuditEvent: { findFirst: vi.fn().mockResolvedValue({ id: 'event_4' }) },
    supportAgentRunLineage: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(lineage),
    },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: never) => unknown) => callback(tx as never)),
  }
  return { tx, client: client as never, lineage }
}

describe('Support AgentRun lineage action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    audit.mockResolvedValue(undefined)
  })

  it('appends exact lineage and audit without mutating Support, run, approval, action or package state', async () => {
    const h = harness()
    const result = await linkSupportRequestAgentRunAction(input, h.client)
    expect(result).toMatchObject({ requestVersion: 4, replayed: false })
    expect(h.tx.supportRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'request_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
    expect(h.tx.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run_1', tenantId: 'tenant_1', venueId: 'venue_1' } }),
    )
    expect(h.tx.supportRequestAuditEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ requestVersion: 4 }) }),
    )
    expect(h.tx.supportAgentRunLineage.create).toHaveBeenCalledOnce()
    expect(h.tx.supportRequest).not.toHaveProperty('update')
    expect(h.tx.supportRequest).not.toHaveProperty('updateMany')
    expect(h.tx.agentRun).not.toHaveProperty('create')
    expect(h.tx.agentRun).not.toHaveProperty('update')
    expect(h.tx).not.toHaveProperty('approvalRequest')
    expect(h.tx).not.toHaveProperty('approvalDecision')
    expect(h.tx).not.toHaveProperty('agentAction')
    expect(h.tx).not.toHaveProperty('venuePackage')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        afterState: expect.objectContaining({
          agentRunLifecycleChanged: false,
          executionTriggered: false,
        }),
      }),
      h.tx,
    )
  })

  it('fails closed for stale or missing exact request-version evidence and wrong run scope', async () => {
    const stale = harness()
    stale.tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      status: 'IN_REVIEW',
      version: 5,
    })
    await expect(linkSupportRequestAgentRunAction(input, stale.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    const evidence = harness()
    evidence.tx.supportRequestAuditEvent.findFirst.mockResolvedValueOnce(null)
    await expect(linkSupportRequestAgentRunAction(input, evidence.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    const scope = harness()
    scope.tx.agentRun.findFirst.mockResolvedValueOnce(null)
    await expect(linkSupportRequestAgentRunAction(input, scope.client)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects mutable run state instead of preserving a misleading snapshot', async () => {
    const h = harness()
    h.tx.agentRun.findFirst.mockResolvedValueOnce({
      id: 'run_1',
      status: 'RUNNING',
      agentIdentityId: 'agent_1',
      completedAt: null,
    })
    await expect(linkSupportRequestAgentRunAction(input, h.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(h.tx.supportAgentRunLineage.create).not.toHaveBeenCalled()
  })

  it('authorizes a nonblank HUMAN PLATFORM_ADMIN before transaction work', async () => {
    const h = harness()
    await expect(
      linkSupportRequestAgentRunAction(
        { ...input, actor: { ...input.actor, actorId: ' ' } },
        h.client,
      ),
    ).rejects.toBeInstanceOf(SupportAgentRunLineageError)
    expect(
      (h.client as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction,
    ).not.toHaveBeenCalled()
  })

  it('replays exact immutable evidence without writes and rejects operation collisions', async () => {
    const h = harness()
    await linkSupportRequestAgentRunAction(input, h.client)
    const created = h.tx.supportAgentRunLineage.create.mock.calls[0]![0].data
    h.tx.supportAgentRunLineage.findFirst.mockResolvedValue({
      ...h.lineage,
      operationHash: created.operationHash,
    })
    h.tx.supportAgentRunLineage.create.mockClear()
    audit.mockClear()
    const replay = await linkSupportRequestAgentRunAction(input, h.client)
    expect(replay).toMatchObject({ requestVersion: 4, replayed: true })
    expect(h.tx.supportAgentRunLineage.create).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()

    await expect(
      linkSupportRequestAgentRunAction({ ...input, agentRunId: 'run_2' }, h.client),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('re-runs exact scope checks in a fresh transaction after P2002', async () => {
    const h = harness()
    h.tx.supportAgentRunLineage.create.mockRejectedValueOnce({ code: 'P2002' })
    h.tx.supportAgentRunLineage.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...h.lineage,
        operationHash: 'placeholder',
      })
    await expect(linkSupportRequestAgentRunAction(input, h.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(h.tx.supportRequest.findFirst).toHaveBeenCalledTimes(2)
    expect(h.tx.agentRun.findFirst).toHaveBeenCalledTimes(2)
  })
})

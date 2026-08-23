import { describe, expect, it, vi } from 'vitest'

import {
  LocationDraftProposalActionError,
  prepareLocationDraftProposalAction,
} from './location-draft-proposal-actions'

const operationId = '11111111-1111-4111-8111-111111111111'
const draft = {
  stableKey: 'east-entrance',
  kind: 'ENTRANCE' as const,
  displayName: 'East entrance',
  description: 'Step-free entrance from Museum Way.',
  visibility: 'PUBLIC' as const,
  floorId: null,
  parentLocationId: null,
  coordinates: null,
  mapAnchor: { x: 10, y: 25 },
  externalMapReference: 'https://museum.example/map',
  accessibilityMetadata: { stepFree: true },
}
const actor = {
  type: 'AGENT' as const,
  actorId: 'agent-1',
  role: 'AGENT' as const,
  agentIdentityId: 'agent-1',
  agentRunId: 'run-1',
  workerId: 'worker-1',
  credentialId: 'credential-1',
  capability: 'locations:propose',
  modelProvider: 'openai',
  modelName: 'gpt-test',
  idempotencyKey: operationId,
}
const input = {
  operationId,
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  reason: 'The current public visitor map identifies this accessible entrance.',
  evidence: [{ type: 'PublicMap', id: 'map-2026-08' }],
  draft,
  actor,
}
const snapshot = {
  contractVersion: 1,
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  draft,
  canonicalVenueContentChanged: false,
}

function harness() {
  const created = {
    id: operationId,
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    agentIdentityId: 'agent-1',
    agentRunId: 'run-1',
    proposedAction: 'torchiko.locations.create_draft',
    scopeSnapshot: snapshot,
    reason: input.reason,
    createdAt: new Date('2026-08-23T20:00:00.000Z'),
  }
  const tx = {
    approvalRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({ id: 'run-1', requestedOperation: 'map venue' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
    venueFloor: { findFirst: vi.fn() },
    venueLocation: { findFirst: vi.fn() },
    agentAction: { create: vi.fn().mockResolvedValue({ id: 'action-1' }) },
    agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline-1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  }
  return {
    created,
    tx,
    client: {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    },
  }
}

describe('prepareLocationDraftProposalAction', () => {
  it('creates approval and agent evidence without changing venue content', async () => {
    const h = harness()
    await expect(prepareLocationDraftProposalAction(input, h.client as never)).resolves.toEqual({
      approvalRequest: h.created,
      replayed: false,
    })
    expect(h.tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: operationId,
          proposedAction: 'torchiko.locations.create_draft',
          scopeSnapshot: snapshot,
          riskCategory: 'MEDIUM',
        }),
      }),
    )
    expect(h.tx.agentAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionName: 'torchiko.locations.propose_draft' }),
      }),
    )
    expect(h.tx.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'AWAITING_APPROVAL' } }),
    )
    expect(h.tx.venueLocation.findFirst).not.toHaveBeenCalled()
  })

  it('replays only the exact proposal operation', async () => {
    const h = harness()
    h.tx.approvalRequest.findUnique.mockResolvedValue({
      ...h.created,
      artifacts: input.evidence,
      decision: null,
    })
    await expect(
      prepareLocationDraftProposalAction(input, h.client as never),
    ).resolves.toMatchObject({
      replayed: true,
    })
    await expect(
      prepareLocationDraftProposalAction(
        { ...input, reason: 'Different reason for the same operation.' },
        h.client as never,
      ),
    ).rejects.toBeInstanceOf(LocationDraftProposalActionError)
    expect(h.tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('fails closed when the enabled identity is not authorized for location proposals', async () => {
    const h = harness()
    h.tx.agentIdentity.findFirst.mockResolvedValue(null)
    await expect(
      prepareLocationDraftProposalAction(input, h.client as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(h.tx.approvalRequest.create).not.toHaveBeenCalled()
  })
})

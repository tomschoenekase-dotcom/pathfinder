import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { resolveSupportProposalContentEvidence } from './support-proposal-content-evidence'

const scope = {
  tenantId: 'tenant-evidence',
  venueId: 'venue-evidence',
  proposalId: '00000000-0000-4000-8000-000000000001',
}

const sourceProposal = {
  id: 'source-proposal',
  supportRequestId: 'support-request',
  supportRequestVersion: 4,
  evidenceMessageIds: ['message-2', 'message-1'],
  producedByConflictResolution: null,
}

function dbWith(overrides: Record<string, unknown> = {}) {
  return {
    knowledgeChangeProposal: { findFirst: vi.fn().mockResolvedValue(sourceProposal) },
    supportRequest: { findFirst: vi.fn().mockResolvedValue({ id: 'support-request' }) },
    supportRequestAuditEvent: { findUnique: vi.fn().mockResolvedValue({ id: 'audit-event' }) },
    supportMessage: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'message-1',
          body: 'First supporting text.',
          createdAt: new Date('2026-09-01T12:00:00Z'),
        },
        {
          id: 'message-2',
          body: 'Second supporting text.',
          createdAt: new Date('2026-09-02T12:00:00Z'),
        },
      ]),
    },
    ...overrides,
  }
}

describe('resolveSupportProposalContentEvidence', () => {
  it('returns ordered, hashed evidence from the exact frozen support scope', async () => {
    const db = dbWith()

    const result = await resolveSupportProposalContentEvidence({ db: db as never, ...scope })

    expect(db.knowledgeChangeProposal.findFirst).toHaveBeenCalledWith({
      where: { id: scope.proposalId, tenantId: scope.tenantId, venueId: scope.venueId },
      select: expect.any(Object),
    })
    expect(db.supportMessage.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: sourceProposal.evidenceMessageIds },
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        supportRequestId: 'support-request',
        requestVersion: { not: null, lte: 4 },
      },
      select: { id: true, body: true, createdAt: true },
    })
    expect(result).toEqual([
      {
        sourceId: 'support-message:message-2',
        locator: 'support-request:support-request',
        capturedAt: '2026-09-02T12:00:00.000Z',
        excerptHash: createHash('sha256').update('Second supporting text.', 'utf8').digest('hex'),
      },
      {
        sourceId: 'support-message:message-1',
        locator: 'support-request:support-request',
        capturedAt: '2026-09-01T12:00:00.000Z',
        excerptHash: createHash('sha256').update('First supporting text.', 'utf8').digest('hex'),
      },
    ])
    expect(JSON.stringify(result)).not.toContain('supporting text')
  })

  it('follows conflict replacement lineage through a second scoped original-proposal lookup', async () => {
    const replacement = {
      ...sourceProposal,
      id: scope.proposalId,
      supportRequestId: null,
      supportRequestVersion: null,
      evidenceMessageIds: [],
      producedByConflictResolution: { proposalId: 'source-proposal' },
    }
    const db = dbWith({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValueOnce(replacement).mockResolvedValueOnce(sourceProposal),
      },
    })

    const result = await resolveSupportProposalContentEvidence({ db: db as never, ...scope })

    expect(result).toHaveLength(2)
    expect(db.knowledgeChangeProposal.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'source-proposal', tenantId: scope.tenantId, venueId: scope.venueId },
      select: expect.any(Object),
    })
  })

  it('rejects a proposal missing from the exact tenant and venue scope', async () => {
    const db = dbWith({
      knowledgeChangeProposal: { findFirst: vi.fn().mockResolvedValue(null) },
    })

    await expect(
      resolveSupportProposalContentEvidence({ db: db as never, ...scope }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects when the frozen support request version cannot be verified', async () => {
    const db = dbWith({
      supportRequestAuditEvent: { findUnique: vi.fn().mockResolvedValue(null) },
    })

    await expect(
      resolveSupportProposalContentEvidence({ db: db as never, ...scope }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(db.supportMessage.findMany).not.toHaveBeenCalled()
  })

  it('rejects duplicate evidence IDs before reading support provenance', async () => {
    const db = dbWith({
      knowledgeChangeProposal: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ ...sourceProposal, evidenceMessageIds: ['message-1', 'message-1'] }),
      },
    })

    await expect(
      resolveSupportProposalContentEvidence({ db: db as never, ...scope }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(db.supportRequest.findFirst).not.toHaveBeenCalled()
  })

  it('rejects chained conflict replacement lineage', async () => {
    const replacement = {
      ...sourceProposal,
      id: scope.proposalId,
      supportRequestId: null,
      supportRequestVersion: null,
      evidenceMessageIds: [],
      producedByConflictResolution: { proposalId: 'source-proposal' },
    }
    const chained = {
      ...sourceProposal,
      producedByConflictResolution: { proposalId: 'earlier-proposal' },
    }
    const db = dbWith({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValueOnce(replacement).mockResolvedValueOnce(chained),
      },
    })

    await expect(
      resolveSupportProposalContentEvidence({ db: db as never, ...scope }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(db.supportRequest.findFirst).not.toHaveBeenCalled()
  })

  it('rejects foreign or missing messages returned outside the frozen scope', async () => {
    const db = dbWith({
      supportMessage: { findMany: vi.fn().mockResolvedValue([{ id: 'message-1' }]) },
    })

    await expect(
      resolveSupportProposalContentEvidence({ db: db as never, ...scope }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

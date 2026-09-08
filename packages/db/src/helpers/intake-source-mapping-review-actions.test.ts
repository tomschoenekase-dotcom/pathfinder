import { describe, expect, it, vi } from 'vitest'

vi.mock('./audit', () => ({ writeAuditLogStrict: vi.fn().mockResolvedValue(undefined) }))

import {
  intakeSourceMappingDigest,
  reviewIntakeSourceForV1,
} from './intake-source-mapping-review-actions'

const input = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  operationId: '11111111-1111-4111-8111-111111111111',
  sourceRunId: 'source-a',
  expectedSourceInputHash: 'a'.repeat(64),
  kind: 'OPTIONAL_NOTES_SELECTION' as const,
  reviewedBy: 'reviewer-a',
  rationale: 'This exact excerpt is approved for proposal review.',
  requestIdentity: { schemaVersion: 1, ranges: [{ start: 0, end: 5 }] },
}

const projection = {
  researchReceiptId: null,
  researchHash: null,
  selectionSnapshot: { ranges: [{ start: 0, end: 5 }] },
  selectionHash: 'b'.repeat(64),
  payload: { schemaVersion: 3 },
  payloadHash: 'c'.repeat(64),
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'source-a' }]),
    intakeSourceMappingReview: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: input.operationId,
        proposalRunId: 'proposal-a',
        kind: input.kind,
        mappingVersion: 1,
        selectionHash: projection.selectionHash,
        payloadHash: projection.payloadHash,
        createdAt: new Date('2026-09-07T12:00:00Z'),
      }),
    },
    intakeRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'source-a',
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        status: 'AWAITING_REVIEW',
        submissionInputHash: input.expectedSourceInputHash,
        requestedBy: 'owner-a',
        requestedByType: 'HUMAN',
        agentIdentityId: null,
        agentRunId: null,
        workerId: null,
        credentialId: null,
        approvalGrantId: null,
        capability: null,
        modelProvider: null,
        modelName: null,
        structuredBootstrap: { kind: 'OPTIONAL_NOTES', notes: 'hello' },
        evidence: [],
      }),
      create: vi.fn().mockResolvedValue({ id: 'proposal-a' }),
    },
    intakeEvidenceRecord: { create: vi.fn().mockResolvedValue({}) },
    intakeRunEvent: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
}

function client(tx: ReturnType<typeof transaction>) {
  return { $transaction: vi.fn(async (callback) => callback(tx)) }
}

describe('intake source mapping review persistence', () => {
  it('atomically retains the review and derived proposal with source ownership and reviewer audit', async () => {
    const tx = transaction()
    const projector = vi.fn().mockResolvedValue(projection)
    const result = await reviewIntakeSourceForV1(input, projector, client(tx) as never)
    expect(result).toMatchObject({ proposalRunId: 'proposal-a', replayed: false })
    expect(tx.intakeRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestedBy: 'owner-a', requestedByType: 'HUMAN' }),
      }),
    )
    expect(tx.intakeSourceMappingReview.create).toHaveBeenCalledTimes(1)
    expect(projector).toHaveBeenCalledTimes(1)
  })

  it('returns exact replay before source locking or mutable projection', async () => {
    const replay = {
      id: input.operationId,
      venueId: input.venueId,
      sourceRunId: input.sourceRunId,
      sourceInputHash: input.expectedSourceInputHash,
      kind: input.kind,
      reviewedBy: input.reviewedBy,
      rationale: input.rationale,
      requestHash: intakeSourceMappingDigest(input.requestIdentity),
      proposalRunId: 'proposal-a',
      mappingVersion: 1,
      selectionHash: projection.selectionHash,
      payloadHash: projection.payloadHash,
      createdAt: new Date(),
    }
    const tx = transaction({
      intakeSourceMappingReview: {
        findFirst: vi.fn().mockResolvedValue(replay),
        create: vi.fn(),
      },
    })
    const projector = vi.fn()
    await expect(
      reviewIntakeSourceForV1(input, projector, client(tx) as never),
    ).resolves.toMatchObject({
      replayed: true,
    })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(projector).not.toHaveBeenCalled()
  })

  it('rejects replay scope changes and changed locked source identity without writes', async () => {
    const replayTx = transaction({
      intakeSourceMappingReview: {
        findFirst: vi.fn().mockResolvedValue({
          id: input.operationId,
          venueId: 'venue-other',
          sourceRunId: input.sourceRunId,
          sourceInputHash: input.expectedSourceInputHash,
          kind: input.kind,
          reviewedBy: input.reviewedBy,
          rationale: input.rationale,
          requestHash: intakeSourceMappingDigest(input.requestIdentity),
          proposalRunId: 'proposal-a',
          mappingVersion: 1,
          selectionHash: projection.selectionHash,
          payloadHash: projection.payloadHash,
          createdAt: new Date(),
        }),
        create: vi.fn(),
      },
    })
    await expect(
      reviewIntakeSourceForV1(input, vi.fn(), client(replayTx) as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const sourceTx = transaction()
    sourceTx.intakeRun.findFirst.mockResolvedValueOnce({
      ...(await sourceTx.intakeRun.findFirst()),
      submissionInputHash: 'f'.repeat(64),
    })
    await expect(
      reviewIntakeSourceForV1(input, vi.fn(), client(sourceTx) as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(sourceTx.intakeSourceMappingReview.create).not.toHaveBeenCalled()
  })
})

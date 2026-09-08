import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

import type { TRPCContext } from '../context'
import { captureMediaTemporalReview } from './media-temporal-review-capture'
import { mediaIntakeHash } from './media-intake-snapshot'
import { mediaTemporalReceiptInput } from './media-temporal-review-receipt'
import { listKnowledgeProposalTemporalEvidenceOptions } from './knowledge-proposal-temporal-evidence-options'

const updatedAt = new Date('2026-09-08T10:00:00.000Z')
function fixture(
  baseContent = 'The east gallery is temporarily closed.',
  isEnabled = true,
  groupCount = 1,
) {
  const text = 'The east gallery is temporarily closed.'
  const observation = {
    kind: 'visible_text' as const,
    statement: text,
    evidenceChannel: 'visible_text' as const,
    directness: 'observed' as const,
    confidence: 'confirmed' as const,
    processingMethod: 'provider_image_analysis' as const,
    locator: { type: 'whole_source' as const },
  }
  const draft = VenuePackagePayloadV1.parse({
    schemaVersion: 1,
    places: [],
    knowledgeEntries: [
      { title: 'East gallery', category: 'access', content: baseContent, isEnabled },
    ],
  })
  const input = {
    tenantId: 'tenant',
    venueId: 'venue',
    projectId: 'project',
    sourceGeneration: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    expectedUpdatedAt: '2026-09-08T09:00:00.000Z',
    rationale: 'Reviewed dated notice.',
    claims: Array.from({ length: groupCount }, (_, index) => ({
      claimId: index === 0 ? 'closure' : `closure-${index}`,
      targetKey: index === 0 ? 'east' : `east-${index}`,
      targetItemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
      value: text,
      valueHash: createHash('sha256').update(text).digest('hex'),
      claimType: 'TEMPORARY_SCHEDULE' as const,
      authority: 'AUTHORIZED_STAFF' as const,
      consequential: true,
      effectiveFrom: '2026-09-08T00:00:00.000Z',
      effectiveUntil: index === 20 ? '2026-09-11T00:00:00.000Z' : '2026-09-15T00:00:00.000Z',
      source: {
        sourceId: 'notice',
        sourceSha256: 'a'.repeat(64),
        sourceVersion: '00000000-0000-4000-8000-000000000003',
        capturedAt: null,
        observationIndex: 0,
        observationSha256: mediaIntakeHash(observation),
      },
    })),
    bindings: [
      {
        kind: 'knowledge' as const,
        itemIndex: 0,
        itemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
        sourceIds: ['notice'],
      },
    ],
  }
  const snapshot = captureMediaTemporalReview({
    input,
    actorId: 'reviewer',
    uploadAttemptId: '00000000-0000-4000-8000-000000000003',
    draft,
    findings: [
      {
        sourceId: 'notice',
        filename: 'notice.png',
        mediaType: 'IMAGE',
        summary: 'Closure.',
        uncertainties: [],
        sourceObservations: [observation],
      },
    ],
    evaluatedAt: '2026-09-08T10:00:00.000Z',
    assets: [
      {
        id: 'asset',
        sourceId: 'notice',
        filename: 'notice.png',
        mediaType: 'IMAGE',
        sha256: 'a'.repeat(64),
        status: 'COMPLETE',
      },
    ],
  })
  const snapshotHash = mediaIntakeHash(snapshot)
  return {
    id: '00000000-0000-4000-8000-000000000004',
    tenantId: 'tenant',
    venueId: 'venue',
    snapshot,
    snapshotHash,
    requestHash: mediaIntakeHash({
      input: mediaTemporalReceiptInput(snapshot),
      actorId: 'reviewer',
    }),
    actorId: 'reviewer',
    evaluatedAt: new Date(snapshot.temporalReview.evaluatedAt),
    createdAt: new Date('2026-09-08T11:00:00.000Z'),
  }
}
function client(
  receipt: ReturnType<typeof fixture> | null,
  proposal = { status: 'PENDING_REVIEW', updatedAt, conversationInsightId: 'insight' },
) {
  return {
    knowledgeChangeProposal: { findFirst: vi.fn().mockResolvedValue(proposal) },
    mediaTemporalReviewReceipt: { findFirst: vi.fn().mockResolvedValue(receipt) },
  } as unknown as TRPCContext['db']
}
const query = {
  tenantId: 'tenant',
  venueId: 'venue',
  proposalId: '00000000-0000-4000-8000-000000000005',
  expectedUpdatedAt: updatedAt,
}

describe('temporal evidence options', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-10T00:00:00.000Z') }))
  it('projects a bounded unverified candidate from an exact validated receipt', async () => {
    const receipt = fixture()
    const result = await listKnowledgeProposalTemporalEvidenceOptions({
      db: client(receipt),
      input: query,
    })
    expect(result).toMatchObject({
      requiresTemporalEvidence: true,
      items: [
        {
          reference: {
            reviewReceiptId: receipt.id,
            expectedSnapshotHash: receipt.snapshotHash,
            claimId: 'closure',
          },
          desired: {
            title: 'East gallery',
            category: 'access',
            content: 'The east gallery is temporarily closed.',
            isEnabled: true,
          },
          validFrom: '2026-09-08T00:00:00.000Z',
          validUntil: '2026-09-15T00:00:00.000Z',
          sourceNames: ['notice.png'],
        },
      ],
      nextCursor: { receiptId: receipt.id, claimOffset: 0 },
    })
  })
  it('returns an honest empty page and preserves the proposal requirement', async () => {
    await expect(
      listKnowledgeProposalTemporalEvidenceOptions({ db: client(null), input: query }),
    ).resolves.toEqual({ items: [], nextCursor: null, requiresTemporalEvidence: true })
  })
  it('uses the claim body while preserving the reviewed target enabled state', async () => {
    const receipt = fixture('Permanent east gallery description.', false)
    const result = await listKnowledgeProposalTemporalEvidenceOptions({
      db: client(receipt),
      input: query,
    })
    expect(result.items[0]!.desired).toEqual({
      title: 'East gallery',
      category: 'access',
      content: 'The east gallery is temporarily closed.',
      isEnabled: false,
    })
  })
  it('includes the receipt identity in otherwise identical group keys', async () => {
    const first = fixture()
    const second = { ...fixture(), id: '00000000-0000-4000-8000-000000000006' }
    const [left, right] = await Promise.all([
      listKnowledgeProposalTemporalEvidenceOptions({ db: client(first), input: query }),
      listKnowledgeProposalTemporalEvidenceOptions({ db: client(second), input: query }),
    ])
    expect(left.items[0]!.key).not.toBe(right.items[0]!.key)
  })
  it('advances by the immutable raw page when an item expires between pages', async () => {
    const receipt = fixture(undefined, true, 21)
    const first = await listKnowledgeProposalTemporalEvidenceOptions({
      db: client(receipt),
      input: query,
    })
    expect(first.items).toHaveLength(20)
    expect(first.nextCursor?.claimOffset).toBe(20)
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
    const second = await listKnowledgeProposalTemporalEvidenceOptions({
      db: client(receipt),
      input: { ...query, cursor: first.nextCursor! },
    })
    expect(second.items).toEqual([])
    expect(second.nextCursor?.claimOffset).toBe(0)
  })
  it.each([
    [
      'stale proposal',
      client(fixture(), {
        status: 'PENDING_REVIEW',
        updatedAt: new Date(0),
        conversationInsightId: 'insight',
      }),
      query,
    ],
    ['tampered receipt', client({ ...fixture(), requestHash: 'f'.repeat(64) }), query],
    [
      'forged continuing cursor',
      client(null),
      {
        ...query,
        cursor: {
          receiptId: '00000000-0000-4000-8000-000000000099',
          createdAt: '2026-09-08T11:00:00.000Z',
          claimOffset: 1,
        },
      },
    ],
  ])('fails closed for %s', async (_name, db, input) => {
    await expect(listKnowledgeProposalTemporalEvidenceOptions({ db, input })).rejects.toThrow()
  })
})

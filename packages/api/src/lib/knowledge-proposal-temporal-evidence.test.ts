import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

import type { TRPCContext } from '../context'

import { captureMediaTemporalReview } from './media-temporal-review-capture'
import { mediaIntakeHash } from './media-intake-snapshot'
import { mediaTemporalReceiptInput } from './media-temporal-review-receipt'
import {
  KnowledgeProposalTemporalEvidenceReference,
  resolveKnowledgeProposalTemporalEvidence,
} from './knowledge-proposal-temporal-evidence'

const NOW = new Date('2026-09-10T12:00:00.000Z')
const START = new Date('2026-09-08T00:00:00.000Z')
const END = new Date('2026-09-15T00:00:00.000Z')

function fixture(
  includeSecondSource = true,
  secondSourceHash = 'b'.repeat(64),
  secondAuthority: 'PUBLIC_SOURCE' | 'HISTORICAL_SOURCE' = 'PUBLIC_SOURCE',
  secondEffectiveUntil = END.toISOString(),
) {
  const observation = {
    kind: 'visible_text' as const,
    statement: 'The east gallery is temporarily closed.',
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
      { title: 'East gallery closure', category: 'access', content: observation.statement },
    ],
  })
  const input = {
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    projectId: 'project-1',
    sourceGeneration: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    expectedUpdatedAt: '2026-09-07T09:00:00.000Z',
    rationale: 'Reviewed the dated closure notice.',
    claims: [
      {
        claimId: 'east-gallery-closure',
        targetKey: 'east-gallery',
        targetItemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
        value: observation.statement,
        valueHash: createHash('sha256').update(observation.statement).digest('hex'),
        claimType: 'TEMPORARY_SCHEDULE' as const,
        authority: 'AUTHORIZED_STAFF' as const,
        consequential: true,
        effectiveFrom: START.toISOString(),
        effectiveUntil: END.toISOString(),
        source: {
          sourceId: 'notice',
          sourceSha256: 'a'.repeat(64),
          sourceVersion: '00000000-0000-4000-8000-000000000003',
          capturedAt: null,
          observationIndex: 0,
          observationSha256: mediaIntakeHash(observation),
        },
      },
      ...(includeSecondSource
        ? [
            {
              claimId: 'east-gallery-closure-copy',
              targetKey: 'east-gallery',
              targetItemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
              value: observation.statement,
              valueHash: createHash('sha256').update(observation.statement).digest('hex'),
              claimType: 'TEMPORARY_SCHEDULE' as const,
              authority: secondAuthority,
              consequential: true,
              effectiveFrom: START.toISOString(),
              effectiveUntil: secondEffectiveUntil,
              source: {
                sourceId: 'notice-copy',
                sourceSha256: secondSourceHash,
                sourceVersion: '00000000-0000-4000-8000-000000000003',
                capturedAt: null,
                observationIndex: 0,
                observationSha256: mediaIntakeHash(observation),
              },
            },
          ]
        : []),
    ],
    bindings: [
      {
        kind: 'knowledge' as const,
        itemIndex: 0,
        itemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
        sourceIds: includeSecondSource ? ['notice', 'notice-copy'] : ['notice'],
      },
    ],
  }
  const snapshot = captureMediaTemporalReview({
    input,
    actorId: 'reviewer-1',
    uploadAttemptId: '00000000-0000-4000-8000-000000000003',
    draft,
    findings: [
      {
        sourceId: 'notice',
        filename: 'closure.png',
        mediaType: 'IMAGE',
        summary: 'Dated closure notice.',
        uncertainties: [],
        sourceObservations: [observation],
      },
      ...(includeSecondSource
        ? [
            {
              sourceId: 'notice-copy',
              filename: 'closure-copy.png',
              mediaType: 'IMAGE',
              summary: 'Second dated closure notice.',
              uncertainties: [],
              sourceObservations: [observation],
            },
          ]
        : []),
    ],
    evaluatedAt: '2026-09-07T10:00:00.000Z',
    assets: [
      {
        id: 'asset-1',
        sourceId: 'notice',
        filename: 'closure.png',
        mediaType: 'IMAGE',
        sha256: 'a'.repeat(64),
        status: 'COMPLETE',
      },
      ...(includeSecondSource
        ? [
            {
              id: 'asset-2',
              sourceId: 'notice-copy',
              filename: 'closure-copy.png',
              mediaType: 'IMAGE',
              sha256: secondSourceHash,
              status: 'COMPLETE',
            },
          ]
        : []),
    ],
  })
  const snapshotHash = mediaIntakeHash(snapshot)
  const row = {
    id: '00000000-0000-4000-8000-000000000004',
    tenantId: input.tenantId,
    venueId: input.venueId,
    snapshot,
    snapshotHash,
    requestHash: mediaIntakeHash({
      input: mediaTemporalReceiptInput(snapshot),
      actorId: 'reviewer-1',
    }),
    actorId: 'reviewer-1',
    evaluatedAt: new Date(snapshot.temporalReview.evaluatedAt),
  }
  const reference = {
    reviewReceiptId: row.id,
    expectedSnapshotHash: snapshotHash,
    claimId: input.claims[0]!.claimId,
  }
  return { row, reference, content: observation.statement }
}

function database(row: ReturnType<typeof fixture>['row'] | null) {
  return {
    mediaTemporalReviewReceipt: { findFirst: vi.fn().mockResolvedValue(row) },
  } as unknown as TRPCContext['db']
}

describe('knowledge proposal temporal evidence', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }))
  afterEach(() => vi.useRealTimers())

  it('resolves one exact scoped, reviewed and still-current claim without upgrading authority', async () => {
    const value = fixture()
    const db = database(value.row)
    const result = await resolveKnowledgeProposalTemporalEvidence({
      db,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      reference: value.reference,
      desiredTitle: 'East gallery closure',
      desiredCategory: 'access',
      desiredContent: value.content,
      validFrom: START.toISOString(),
      validUntil: END.toISOString(),
    })
    expect(result).toMatchObject({
      reference: value.reference,
      reviewedBy: 'reviewer-1',
      reviewedAt: '2026-09-07T10:00:00.000Z',
      authorityBasis: 'REVIEW_ASSERTED',
      authorityVerified: false,
      targetKey: 'east-gallery',
      targetItemHash: value.row.snapshot.items[0]!.binding.itemHash,
    })
    expect(result.sourceRef).toBe(
      `media-temporal-receipt:${value.row.id}:snapshot:${value.row.snapshotHash}:claim:${result.claimHash}`,
    )
    expect(db.mediaTemporalReviewReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: value.row.id, tenantId: 'tenant-1', venueId: 'venue-1' },
      }),
    )
  })

  it('normalizes UUID references and rejects unknown reference fields', () => {
    const value = fixture()
    expect(
      KnowledgeProposalTemporalEvidenceReference.parse({
        ...value.reference,
        reviewReceiptId: value.reference.reviewReceiptId.toUpperCase(),
      }).reviewReceiptId,
    ).toBe(value.reference.reviewReceiptId)
    expect(() =>
      KnowledgeProposalTemporalEvidenceReference.parse({ ...value.reference, actorId: 'spoofed' }),
    ).toThrow()
  })

  it('rejects a sole caller-labelled staff source without reviewed source agreement', async () => {
    const value = fixture(false)
    await expect(
      resolveKnowledgeProposalTemporalEvidence({
        db: database(value.row),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        reference: value.reference,
        desiredTitle: 'East gallery closure',
        desiredCategory: 'access',
        desiredContent: value.content,
        validFrom: START.toISOString(),
        validUntil: END.toISOString(),
      }),
    ).rejects.toThrow('two distinct agreeing sources')
  })

  it('requires distinct source hashes rather than only distinct source records', async () => {
    const value = fixture(true, 'a'.repeat(64))
    await expect(
      resolveKnowledgeProposalTemporalEvidence({
        db: database(value.row),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        reference: value.reference,
        desiredTitle: 'East gallery closure',
        desiredCategory: 'access',
        desiredContent: value.content,
        validFrom: START.toISOString(),
        validUntil: END.toISOString(),
      }),
    ).rejects.toThrow('two distinct agreeing sources')
  })

  it('does not count an agreeing historical source as current corroboration', async () => {
    const value = fixture(true, 'b'.repeat(64), 'HISTORICAL_SOURCE')
    await expect(
      resolveKnowledgeProposalTemporalEvidence({
        db: database(value.row),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        reference: value.reference,
        desiredTitle: 'East gallery closure',
        desiredCategory: 'access',
        desiredContent: value.content,
        validFrom: START.toISOString(),
        validUntil: END.toISOString(),
      }),
    ).rejects.toThrow('two distinct agreeing sources')
  })

  it('requires source agreement throughout the selected claim interval', async () => {
    const value = fixture(true, 'b'.repeat(64), 'PUBLIC_SOURCE', '2026-09-12T00:00:00.000Z')
    await expect(
      resolveKnowledgeProposalTemporalEvidence({
        db: database(value.row),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        reference: value.reference,
        desiredTitle: 'East gallery closure',
        desiredCategory: 'access',
        desiredContent: value.content,
        validFrom: START.toISOString(),
        validUntil: END.toISOString(),
      }),
    ).rejects.toThrow('two distinct agreeing sources')
  })

  it.each([
    ['missing receipt', () => ({ row: null, input: {} })],
    [
      'cross-scope row',
      (value: ReturnType<typeof fixture>) => ({
        row: { ...value.row, venueId: 'other' },
        input: {},
      }),
    ],
    [
      'tampered snapshot',
      (value: ReturnType<typeof fixture>) => ({
        row: { ...value.row, snapshot: { ...value.row.snapshot, reviewRationale: 'changed' } },
        input: {},
      }),
    ],
    [
      'wrong reviewer',
      (value: ReturnType<typeof fixture>) => ({
        row: { ...value.row, actorId: 'other' },
        input: {},
      }),
    ],
    [
      'wrong request hash',
      (value: ReturnType<typeof fixture>) => ({
        row: { ...value.row, requestHash: 'f'.repeat(64) },
        input: {},
      }),
    ],
    [
      'mismatched evaluated time',
      (value: ReturnType<typeof fixture>) => ({
        row: { ...value.row, evaluatedAt: new Date('2026-09-07T11:00:00.000Z') },
        input: {},
      }),
    ],
    [
      'wrong expected hash',
      (value: ReturnType<typeof fixture>) => ({
        row: value.row,
        input: { reference: { ...value.reference, expectedSnapshotHash: 'f'.repeat(64) } },
      }),
    ],
    [
      'unrelated content',
      (value: ReturnType<typeof fixture>) => ({
        row: value.row,
        input: { desiredContent: 'The west gallery is closed.' },
      }),
    ],
    [
      'unrelated title',
      (value: ReturnType<typeof fixture>) => ({
        row: value.row,
        input: { desiredTitle: 'West gallery closure' },
      }),
    ],
    [
      'changed interval',
      (value: ReturnType<typeof fixture>) => ({
        row: value.row,
        input: { validUntil: '2026-09-14T00:00:00.000Z' },
      }),
    ],
    [
      'unknown claim',
      (value: ReturnType<typeof fixture>) => ({
        row: value.row,
        input: { reference: { ...value.reference, claimId: 'unknown' } },
      }),
    ],
  ])('fails closed for %s', async (_label, mutate) => {
    const value = fixture()
    const changed = mutate(value)
    await expect(
      resolveKnowledgeProposalTemporalEvidence({
        db: database(changed.row),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        reference: value.reference,
        desiredTitle: 'East gallery closure',
        desiredCategory: 'access',
        desiredContent: value.content,
        validFrom: START.toISOString(),
        validUntil: END.toISOString(),
        ...changed.input,
      }),
    ).rejects.toThrow()
  })

  it('rejects an exact reviewed claim after its finite interval expires', async () => {
    vi.setSystemTime(new Date('2026-09-15T00:00:00.000Z'))
    const value = fixture()
    await expect(
      resolveKnowledgeProposalTemporalEvidence({
        db: database(value.row),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        reference: value.reference,
        desiredTitle: 'East gallery closure',
        desiredCategory: 'access',
        desiredContent: value.content,
        validFrom: START.toISOString(),
        validUntil: END.toISOString(),
      }),
    ).rejects.toThrow('expired')
  })
})

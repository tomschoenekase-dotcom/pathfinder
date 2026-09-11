import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { reconcileMediaTemporalClaims } from './media-temporal-reconciliation'

import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

import { buildIntakeVenuePackageCandidate } from './intake-venue-package-candidate'
import { buildReviewedMediaIntakeCandidate } from './media-intake-candidate'
import {
  mediaIntakeEvidenceLocator,
  mediaIntakeHash,
  mediaIntakeSnapshotInput,
  validateMediaIntakeSnapshot,
} from './media-intake-snapshot'

function fixture() {
  const draft = VenuePackagePayloadV1.parse({
    schemaVersion: 1,
    places: [{ name: 'East entrance', type: 'entrance', shortDescription: 'Use the east doors.' }],
    knowledgeEntries: [
      { title: 'Arrival', category: 'arrival', content: 'Ask reception about assistance.' },
    ],
  })
  const finding = {
    sourceId: 'video:1',
    filename: 'entrance.mp4',
    mediaType: 'VIDEO' as const,
    videoAnalysisMethod: 'GOOGLE_STATIC_VIDEO_1FPS' as const,
    summary: 'East entrance signage is visible.',
    uncertainties: ['The route beyond the doors was not filmed.'],
    observations: [],
  }
  const snapshot = validateMediaIntakeSnapshot({
    kind: 'MEDIA_PROJECT_REVIEW',
    version: 1,
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    projectId: 'project-a',
    requestId: '65d674b8-2636-42be-8c83-0640248da42a',
    sourceGeneration: '1cbbcc27-aadb-4a4f-bfa7-dced47eaeefe',
    reviewedUpdatedAt: '2026-09-07T07:30:00.000Z',
    reviewedBy: 'admin-a',
    reviewRationale: 'Checked the source and limited the arrival description.',
    draft,
    bindings: [
      {
        kind: 'place',
        itemIndex: 0,
        itemHash: mediaIntakeHash(draft.places[0]),
        sourceIds: ['video:1'],
      },
      {
        kind: 'knowledge',
        itemIndex: 0,
        itemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
        sourceIds: ['video:1'],
      },
    ],
    sources: [
      {
        sourceId: 'video:1',
        assetId: 'asset-a',
        sha256: 'a'.repeat(64),
        filename: finding.filename,
        mediaType: 'VIDEO',
        analysisHash: mediaIntakeHash(finding),
        finding,
      },
    ],
  })
  return {
    id: 'run-a',
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    requestedBy: snapshot.reviewedBy,
    requestedByType: 'HUMAN',
    submissionRequestId: snapshot.requestId,
    submissionInputHash: mediaIntakeHash({
      input: mediaIntakeSnapshotInput(snapshot),
      actorId: snapshot.reviewedBy,
    }),
    structuredBootstrap: snapshot,
    evidence: [
      {
        locator: 'media-project-review:snapshot:v1',
        normalizedHash: mediaIntakeHash(snapshot),
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        confidence: 1,
      },
      {
        locator: mediaIntakeEvidenceLocator(snapshot, 'video:1'),
        normalizedHash: snapshot.sources[0]!.analysisHash,
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        confidence: 1,
      },
    ],
  }
}

describe('reviewed media canonical intake candidate', () => {
  function temporalFixture() {
    const run = fixture()
    const snapshot = run.structuredBootstrap
    const source = snapshot.sources[0]!
    const observation = {
      kind: 'visible_text' as const,
      statement: 'East entrance opening hours.',
      evidenceChannel: 'visible_text' as const,
      directness: 'observed' as const,
      confidence: 'confirmed' as const,
      processingMethod: 'provider_video_static_1fps' as const,
      locator: { type: 'whole_source' as const },
    }
    source.finding.sourceObservations = [observation]
    source.analysisHash = mediaIntakeHash(source.finding)
    const claims = ['Open at 9', 'Open at 11'].map((value, index) => ({
      claimId: `hours-${index}`,
      targetKey: 'entrance:hours',
      targetItemHash: snapshot.bindings[0]!.itemHash,
      claimType: 'STABLE_FACT' as const,
      value,
      valueHash: createHash('sha256').update(value).digest('hex'),
      authority: 'AUTHORIZED_STAFF' as const,
      consequential: true,
      source: {
        sourceId: source.sourceId,
        sourceSha256: source.sha256,
        sourceVersion: 'upload-1',
        capturedAt: null,
        observationIndex: 0,
        observationSha256: mediaIntakeHash(observation),
      },
    }))
    const evaluatedAt = '2026-09-07T09:00:00.000Z'
    snapshot.temporalReview = {
      claims,
      evaluatedAt,
      sourceVersion: 'upload-1',
      reconciliationHash: reconcileMediaTemporalClaims({ claims, now: evaluatedAt })
        .reconciliationHash,
    }
    function seal() {
      run.submissionInputHash = mediaIntakeHash({
        input: mediaIntakeSnapshotInput(snapshot),
        actorId: snapshot.reviewedBy,
      })
      run.evidence[0]!.normalizedHash = mediaIntakeHash(snapshot)
      run.evidence[1]!.normalizedHash = source.analysisHash
    }
    seal()
    return { run, seal }
  }

  it('holds only the conflicted item while retaining all original evidence and stable item identity', () => {
    const { run } = temporalFixture()
    const candidate = buildReviewedMediaIntakeCandidate(run)
    expect(candidate.places.create).toEqual([])
    expect(candidate.knowledgeEntries.create).toEqual(
      buildReviewedMediaIntakeCandidate(fixture()).knowledgeEntries.create,
    )
    expect(run.structuredBootstrap.draft.places).toHaveLength(1)
    expect(run.structuredBootstrap.bindings).toHaveLength(2)
    expect(buildReviewedMediaIntakeCandidate(structuredClone(run))).toEqual(candidate)
  })

  it('never hands date-bound facts to permanent Builder content even when authoritative and active', () => {
    const { run, seal } = temporalFixture()
    const review = run.structuredBootstrap.temporalReview!
    review.claims = [
      {
        ...review.claims[0]!,
        claimType: 'TEMPORARY_SCHEDULE',
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        effectiveUntil: '2026-10-01T00:00:00.000Z',
      },
    ]
    review.reconciliationHash = reconcileMediaTemporalClaims({
      claims: review.claims,
      now: review.evaluatedAt,
    }).reconciliationHash
    seal()
    expect(buildReviewedMediaIntakeCandidate(run).places.create).toEqual([])
  })

  it('retains future and expired schedules on hold when reconstructing an immutable handoff', () => {
    for (const effectiveFrom of ['2025-09-01T00:00:00.000Z', '2027-09-01T00:00:00.000Z']) {
      const { run, seal } = temporalFixture()
      const review = run.structuredBootstrap.temporalReview!
      review.claims = [
        {
          ...review.claims[0]!,
          claimType: 'TEMPORARY_SCHEDULE',
          effectiveFrom,
          effectiveUntil: effectiveFrom.replace('-09-01', '-10-01'),
        },
      ]
      review.reconciliationHash = reconcileMediaTemporalClaims({
        claims: review.claims,
        now: review.evaluatedAt,
      }).reconciliationHash
      seal()
      expect(buildReviewedMediaIntakeCandidate(run).places.create).toEqual([])
      expect(buildReviewedMediaIntakeCandidate(run).knowledgeEntries.create).toHaveLength(1)
    }
  })

  it('rejects temporal source, item and reconciliation tampering even with resealed outer receipts', () => {
    for (const mutate of [
      (
        review: NonNullable<ReturnType<typeof fixture>['structuredBootstrap']['temporalReview']>,
      ) => {
        review.sourceVersion = 'other-upload'
      },
      (
        review: NonNullable<ReturnType<typeof fixture>['structuredBootstrap']['temporalReview']>,
      ) => {
        review.claims[0]!.source.observationSha256 = 'b'.repeat(64)
      },
      (
        review: NonNullable<ReturnType<typeof fixture>['structuredBootstrap']['temporalReview']>,
      ) => {
        review.claims[0]!.targetItemHash = 'c'.repeat(64)
      },
    ]) {
      const { run, seal } = temporalFixture()
      mutate(run.structuredBootstrap.temporalReview!)
      const review = run.structuredBootstrap.temporalReview!
      review.reconciliationHash = reconcileMediaTemporalClaims({
        claims: review.claims,
        now: review.evaluatedAt,
      }).reconciliationHash
      seal()
      expect(() => buildReviewedMediaIntakeCandidate(run)).toThrow()
    }
  })

  it('rejects frozen reconciliation tampering and an entirely held static handoff', () => {
    const { run, seal } = temporalFixture()
    run.structuredBootstrap.temporalReview!.reconciliationHash = 'f'.repeat(64)
    seal()
    expect(() => buildReviewedMediaIntakeCandidate(run)).toThrow('reconciliation')
    const allHeld = temporalFixture()
    const review = allHeld.run.structuredBootstrap.temporalReview!
    review.claims.push(
      ...review.claims.map((claim) => ({
        ...claim,
        claimId: `${claim.claimId}-knowledge`,
        targetKey: 'knowledge:hours',
        targetItemHash: allHeld.run.structuredBootstrap.bindings[1]!.itemHash,
      })),
    )
    review.reconciliationHash = reconcileMediaTemporalClaims({
      claims: review.claims,
      now: review.evaluatedAt,
    }).reconciliationHash
    allHeld.seal()
    expect(() => buildReviewedMediaIntakeCandidate(allHeld.run)).toThrow(
      'All reviewed items are held',
    )
  })
  it('maps exact reviewed items to stable V3 creates with truthful AI provenance', () => {
    const run = fixture()
    const payload = buildReviewedMediaIntakeCandidate(run)
    expect(buildReviewedMediaIntakeCandidate(structuredClone(run))).toEqual(payload)
    expect(payload.places.create[0]?.provenance.contentOrigin).toBe('AI_GENERATED')
    expect(payload.knowledgeEntries.create[0]?.value.content).toBe(
      'Ask reception about assistance.',
    )
    expect(payload.places.update).toEqual([])
    expect(payload.places.delete).toEqual([])
    expect(run.structuredBootstrap.sources[0]?.finding.uncertainties).toEqual([
      'The route beyond the doors was not filmed.',
    ])
  })

  it('rejects altered assets, findings, item text and missing or duplicate evidence', () => {
    const changes = [
      (run: ReturnType<typeof fixture>) => {
        run.structuredBootstrap.sources[0]!.sha256 = 'b'.repeat(64)
      },
      (run: ReturnType<typeof fixture>) => {
        run.structuredBootstrap.sources[0]!.finding.uncertainties = []
      },
      (run: ReturnType<typeof fixture>) => {
        run.structuredBootstrap.draft.places[0]!.name = 'Unreviewed replacement'
      },
      (run: ReturnType<typeof fixture>) => {
        run.evidence.pop()
      },
      (run: ReturnType<typeof fixture>) => {
        run.evidence[1] = run.evidence[0]!
      },
    ]
    for (const change of changes) {
      const run = fixture()
      change(run)
      expect(() => buildReviewedMediaIntakeCandidate(run)).toThrow()
    }
  })

  it('rejects cross-scope, changed reviewer, request identity and machine impersonation', () => {
    for (const patch of [
      { tenantId: 'tenant-b' },
      { venueId: 'venue-b' },
      { requestedBy: 'admin-b' },
      { requestedByType: 'AGENT' },
      { submissionRequestId: '70276c14-fc06-4b3a-bf0f-a40aef0f4917' },
    ]) {
      expect(() => buildReviewedMediaIntakeCandidate({ ...fixture(), ...patch })).toThrow()
    }
  })

  it('requires complete unique item bindings and scoped source coverage', () => {
    for (const mutate of [
      (s: ReturnType<typeof fixture>['structuredBootstrap']) => {
        s.bindings.pop()
      },
      (s: ReturnType<typeof fixture>['structuredBootstrap']) => {
        s.bindings[1] = s.bindings[0]!
      },
      (s: ReturnType<typeof fixture>['structuredBootstrap']) => {
        s.bindings[0]!.sourceIds = ['missing']
      },
      (s: ReturnType<typeof fixture>['structuredBootstrap']) => {
        s.bindings[0]!.sourceIds.push('video:1')
      },
    ]) {
      const snapshot = fixture().structuredBootstrap
      mutate(snapshot)
      expect(() => validateMediaIntakeSnapshot(snapshot)).toThrow()
    }
  })

  it('enters the existing canonical candidate path without auto approval or publication', async () => {
    const run = {
      ...fixture(),
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: null,
    }
    const db = { intakeRun: { findFirst: vi.fn().mockResolvedValue(run) } }
    const candidate = await buildIntakeVenuePackageCandidate({
      db: db as never,
      tenantId: run.tenantId,
      venueId: run.venueId,
      runId: run.id,
    })
    expect(candidate).toMatchObject({
      ready: true,
      autoApprove: false,
      autoApply: false,
      published: false,
      summary: { candidateCount: 2 },
    })
    db.intakeRun.findFirst.mockResolvedValue({ ...run, status: 'REJECTED' })
    const rejected = await buildIntakeVenuePackageCandidate({
      db: db as never,
      tenantId: run.tenantId,
      venueId: run.venueId,
      runId: run.id,
    })
    expect(rejected).toMatchObject({ ready: false, payload: null })
  })

  it('hashes object key order consistently and keeps delimiter-bearing sources distinct', () => {
    expect(mediaIntakeHash({ b: 2, a: 1 })).toBe(mediaIntakeHash({ a: 1, b: 2 }))
    const snapshot = fixture().structuredBootstrap
    expect(mediaIntakeEvidenceLocator(snapshot, 'a:b')).not.toBe(
      mediaIntakeEvidenceLocator({ ...snapshot, projectId: 'project-a:a' }, 'b'),
    )
  })

  it('rejects oversized retained evidence before copying it into canonical intake', () => {
    const snapshot = fixture().structuredBootstrap
    snapshot.sources[0]!.finding.uncertainties = Array(900).fill('x'.repeat(10_000))
    expect(() => validateMediaIntakeSnapshot(snapshot)).toThrow('too large')
  })
})

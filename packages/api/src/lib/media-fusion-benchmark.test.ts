import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assessMediaEntityMatch,
  mediaEvidenceLocatorId,
  type MediaEntityCandidate,
  type MediaEvidenceScope,
} from '@pathfinder/contracts/media-entity-resolution'
import {
  appendMediaResolutionDecision,
  createMediaResolutionState,
  projectMediaResolution,
} from '@pathfinder/contracts/media-resolution-state'
import { describe, expect, it } from 'vitest'

import { mediaFindingSchema } from '../routers/admin/media-ingestion-review-schemas'
import { reviewedTraversalDraft } from './media-relation-application'
import { deriveResolutionCandidates, validateResolutionEvidence } from './media-resolution-evidence'
import { mediaIntakeHash } from './media-intake-snapshot'
import { mediaTemporalHolds, reconcileMediaTemporalClaims } from './media-temporal-reconciliation'

type FixtureAsset = {
  path: string
  mediaType: 'IMAGE' | 'VIDEO' | 'DOCUMENT'
  sha256: string
  durationSeconds?: number
}

type FixtureObservation = {
  observationId: string
  kind: 'entity_candidate' | 'visible_text' | 'narrated_fact' | 'spatial_relation'
  statement: string
  evidenceChannel: 'visual' | 'visible_text' | 'document_text' | 'mixed'
  directness: 'observed' | 'inferred'
  confidence: 'confirmed' | 'probable' | 'unverified'
  evidence: {
    source: string
    locator:
      | { type: 'whole_source' }
      | { type: 'image_region'; x: number; y: number; width: number; height: number }
      | { type: 'document_page'; page: number }
      | { type: 'video_interval'; startSeconds: number; endSeconds: number }
  }
}

type FixtureCase = {
  caseId: string
  scope: { tenantId: string; projectId: string; sourceGeneration: string }
  assets: FixtureAsset[]
  expected: {
    observations: FixtureObservation[]
    entities: {
      candidateIds: string[]
      assessment: 'PROPOSE_MERGE' | 'KEEP_DISTINCT'
      requiredIdentifier?: { scheme: 'inventory_id'; value: string }
      conflictingIdentifiers?: Array<{ scheme: 'inventory_id'; values: string[] }>
      automaticMerge: false
    }
    relations: Array<{
      fromCandidateId: string
      toCandidateId: string
      kind: 'COVISIBLE'
      reviewStatus: 'PENDING'
      mustNotPropose: Array<'TRAVERSABLE'>
      accessibility: 'UNKNOWN'
    }>
    temporal: {
      outcome: 'NO_HOLDS' | 'HELD'
      heldTargetKeys: string[]
      holdReasons?: Array<'DATE_BOUND'>
      staticCandidateIncludesTarget?: false
    }
  }
}

type FixtureManifest = {
  split: 'development' | 'holdout'
  synthetic: true
  providerStatus: 'NOT_RUN'
  cases: FixtureCase[]
}

type NormalizedCase = {
  fixture: FixtureCase
  scope: MediaEvidenceScope
  findings: Array<ReturnType<typeof mediaFindingSchema.parse>>
  assets: Array<{ sourceId: string; sha256: string; status: 'COMPLETE' }>
  observationById: Map<string, { sourceId: string; index: number; value: unknown }>
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
)
const fixtureRoot = path.join(repositoryRoot, 'scripts', 'fixtures', 'media-fusion-v1')
const manifests = ['development', 'holdout'] as const
const requestId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

async function loadCases() {
  const values = await Promise.all(
    manifests.map(async (split) => {
      const raw = JSON.parse(
        await readFile(path.join(fixtureRoot, split, 'manifest.json'), 'utf8'),
      ) as FixtureManifest
      expect(raw).toMatchObject({ split, synthetic: true, providerStatus: 'NOT_RUN' })
      return raw.cases
    }),
  )
  return new Map(values.flat().map((fixture) => [fixture.caseId, fixture]))
}

function normalizeCase(fixture: FixtureCase): NormalizedCase {
  // sourceGeneration and uploadAttemptId are distinct in production. This provider-dark
  // fixture has no upload transaction, so the frozen generation UUID is reused only as
  // the synthetic evidence-scope UUID; no ingestion or extraction success is claimed.
  const scope: MediaEvidenceScope = {
    tenantId: fixture.scope.tenantId,
    projectId: fixture.scope.projectId,
    uploadAttemptId: fixture.scope.sourceGeneration,
  }
  const observationById = new Map<string, { sourceId: string; index: number; value: unknown }>()
  const findings = fixture.assets.map((asset) => {
    const observations = fixture.expected.observations.filter(
      (observation) => observation.evidence.source === asset.path,
    )
    const sourceObservations = observations.map((observation, index) => {
      const raw = observation.evidence.locator
      const locator =
        raw.type === 'image_region'
          ? {
              type: raw.type,
              region: { x: raw.x, y: raw.y, width: raw.width, height: raw.height },
            }
          : raw
      const value = {
        kind: observation.kind,
        statement: observation.statement,
        evidenceChannel: observation.evidenceChannel,
        directness: observation.directness,
        confidence: observation.confidence,
        processingMethod:
          asset.mediaType === 'IMAGE'
            ? ('provider_image_analysis' as const)
            : asset.mediaType === 'DOCUMENT'
              ? ('text_extraction' as const)
              : ('sampled_video_analysis' as const),
        locator,
      }
      observationById.set(observation.observationId, { sourceId: asset.path, index, value })
      return value
    })
    return mediaFindingSchema.parse({
      sourceId: asset.path,
      filename: path.basename(asset.path),
      mediaType: asset.mediaType,
      ...(asset.mediaType === 'VIDEO'
        ? {
            videoAnalysisMethod: 'SAMPLED_VIDEO',
            videoAnalysisCoverage: {
              inputScope: 'sampled-frames',
              visualCoverage: 'bounded-interval-samples',
              audioCoverage: 'optional-transcription',
              exhaustiveFrames: false,
            },
          }
        : {}),
      sourceObservations,
      summary: `Frozen synthetic oracle observations for ${fixture.caseId}.`,
      uncertainties: [
        'Provider extraction was not run; these observations are deterministic benchmark inputs.',
      ],
    })
  })
  return {
    fixture,
    scope,
    findings,
    assets: fixture.assets.map((asset) => ({
      sourceId: asset.path,
      sha256: asset.sha256,
      status: 'COMPLETE' as const,
    })),
    observationById,
  }
}

function candidate(
  normalized: NormalizedCase,
  candidateId: string,
  observationIds: string[],
  identifiers: MediaEntityCandidate['identifiers'] = [],
) {
  const evidence = observationIds.map((observationId) => {
    const observation = normalized.observationById.get(observationId)
    if (!observation) throw new Error(`Unknown frozen observation ${observationId}`)
    const asset = normalized.assets.find((item) => item.sourceId === observation.sourceId)
    if (!asset) throw new Error(`Unknown frozen source ${observation.sourceId}`)
    return {
      ...normalized.scope,
      sourceId: observation.sourceId,
      sourceSha256: asset.sha256,
      observationIndex: observation.index,
      observationSha256: mediaIntakeHash(observation.value),
    }
  })
  return {
    candidateId,
    label: candidateId,
    kind: 'extracted-entity',
    evidence,
    identifiers,
    contextKeys: [],
  }
}

function validateFrozenEvidence(normalized: NormalizedCase, candidates: MediaEntityCandidate[]) {
  return validateResolutionEvidence({
    scope: normalized.scope,
    sourceGeneration: normalized.fixture.scope.sourceGeneration,
    candidates,
    findings: normalized.findings,
    assets: normalized.assets,
  })
}

describe('provider-dark media fusion invariants', () => {
  it('normalizes frozen sources without scoring candidate extraction or implying a provider run', async () => {
    for (const fixture of (await loadCases()).values()) {
      const normalized = normalizeCase(fixture)
      const derived = deriveResolutionCandidates(normalized)
      expect(derived.candidates.every((item) => item.identifiers.length === 0)).toBe(true)
      if (derived.candidates.length > 0) {
        expect(
          projectMediaResolution(createMediaResolutionState(normalized.scope, derived.candidates))
            .groups,
        ).toHaveLength(derived.candidates.length)
      }
    }
  })

  it('proposes exact-identifier matches only for review and reverses the whole group with locators intact', async () => {
    const fixture = (await loadCases()).get('mf-d01-exact-exhibit-cross-media')!
    const normalized = normalizeCase(fixture)
    const identifier = fixture.expected.entities.requiredIdentifier!
    const candidates = [
      candidate(normalized, 'bot-image', ['bot-image-id'], [identifier]),
      candidate(normalized, 'bot-document', ['bot-pdf-id'], [identifier]),
      candidate(normalized, 'bot-video', ['bot-video-id'], [identifier]),
    ]
    validateFrozenEvidence(normalized, candidates)
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        expect(assessMediaEntityMatch(candidates[left]!, candidates[right]!).disposition).toBe(
          fixture.expected.entities.assessment,
        )
      }
    }
    const initial = createMediaResolutionState(normalized.scope, candidates)
    const merged = appendMediaResolutionDecision(initial, {
      kind: 'MERGE',
      requestId: requestId(1),
      reviewerId: 'synthetic-benchmark-reviewer',
      rationale: 'All three frozen sources retain the exact BOT-014 inventory identifier.',
      candidateIds: fixture.expected.entities.candidateIds,
      representativeId: fixture.expected.entities.candidateIds[0],
    })
    expect(projectMediaResolution(merged).groups).toEqual([
      {
        representativeId: fixture.expected.entities.candidateIds[0],
        candidateIds: fixture.expected.entities.candidateIds,
      },
    ])
    const reverted = appendMediaResolutionDecision(merged, {
      kind: 'REVERT_MERGE',
      requestId: requestId(2),
      mergeRequestId: requestId(1),
      reviewerId: 'synthetic-benchmark-reviewer',
      rationale: 'Exercise reversible review without discarding source lineage.',
    })
    expect(projectMediaResolution(reverted).groups).toEqual(projectMediaResolution(initial).groups)
    expect(reverted.candidates).toEqual(initial.candidates)
    expect(
      new Set(reverted.candidates.flatMap((item) => item.evidence.map(mediaEvidenceLocatorId))),
    ).toEqual(
      new Set(initial.candidates.flatMap((item) => item.evidence.map(mediaEvidenceLocatorId))),
    )
  })

  it('keeps lookalike rooms distinct when durable identifiers conflict', async () => {
    const fixture = (await loadCases()).get('mf-h02-lookalike-conservatories')!
    const normalized = normalizeCase(fixture)
    const [conflict] = fixture.expected.entities.conflictingIdentifiers!
    const candidates = [
      candidate(
        normalized,
        'north-palm-house',
        ['twins-image'],
        [{ scheme: conflict!.scheme, value: conflict!.values[0]! }],
      ),
      candidate(
        normalized,
        'south-palm-house',
        ['twins-register', 'twins-video'],
        [{ scheme: conflict!.scheme, value: conflict!.values[1]! }],
      ),
    ]
    validateFrozenEvidence(normalized, candidates)
    expect(assessMediaEntityMatch(candidates[0]!, candidates[1]!)).toMatchObject({
      disposition: fixture.expected.entities.assessment,
      reasons: [expect.stringMatching(/Conflicting inventory_id/u)],
    })
    expect(
      projectMediaResolution(createMediaResolutionState(normalized.scope, candidates)).groups,
    ).toHaveLength(2)
  })

  it('retains co-visibility as review evidence and cannot turn it into native traversability authority', async () => {
    const fixture = (await loadCases()).get('mf-d04-doorway-missing-geometry')!
    const normalized = normalizeCase(fixture)
    const candidates = [
      candidate(normalized, 'east-room', ['door-video']),
      candidate(normalized, 'east-doorway', ['door-image', 'door-coverage']),
    ]
    validateFrozenEvidence(normalized, candidates)
    const evidenceLocatorIds = candidates.flatMap((item) =>
      item.evidence.map(mediaEvidenceLocatorId),
    )
    const initial = createMediaResolutionState(normalized.scope, candidates)
    const proposed = appendMediaResolutionDecision(initial, {
      kind: 'PROPOSE_RELATION',
      requestId: requestId(3),
      reviewerId: 'synthetic-benchmark-reviewer',
      rationale: 'The room and doorway are visible together; the route beyond is absent.',
      relationId: 'east-room-doorway-covisible',
      fromCandidateId: fixture.expected.relations[0]!.fromCandidateId,
      toCandidateId: fixture.expected.relations[0]!.toCandidateId,
      relationKind: fixture.expected.relations[0]!.kind,
      evidenceLocatorIds,
      basis: 'visual_overlap',
      confidence: 'probable',
      observationTime: { kind: 'UNKNOWN' },
      uncertainties: ['Path geometry and accessibility beyond the doorway were not observed.'],
    })
    expect(projectMediaResolution(proposed).relations[0]).toMatchObject({
      relationKind: fixture.expected.relations[0]!.kind,
      reviewStatus: fixture.expected.relations[0]!.reviewStatus,
    })
    expect(() =>
      appendMediaResolutionDecision(initial, {
        kind: 'PROPOSE_RELATION',
        requestId: requestId(4),
        reviewerId: 'synthetic-benchmark-reviewer',
        rationale: 'A visual overlap cannot establish traversability.',
        relationId: 'invalid-doorway-route',
        fromCandidateId: 'east-room',
        toCandidateId: 'east-doorway',
        relationKind: fixture.expected.relations[0]!.mustNotPropose[0],
        evidenceLocatorIds,
        basis: 'visual_overlap',
        confidence: 'probable',
        observationTime: { kind: 'UNKNOWN' },
        uncertainties: ['The route is outside the captured frame.'],
      }),
    ).toThrow(/Traversability requires/u)
    const accepted = appendMediaResolutionDecision(proposed, {
      kind: 'REVIEW_RELATION',
      requestId: requestId(5),
      proposalRequestId: requestId(3),
      verdict: 'ACCEPTED',
      reviewerId: 'synthetic-benchmark-reviewer',
      rationale: 'Accept co-visibility only as retained evidence.',
    })
    expect(() =>
      reviewedTraversalDraft(accepted, 'east-room-doorway-covisible', requestId(5)),
    ).toThrow(/do not authorize a walking connection/u)
  })

  it('holds date-bound hours locally while retaining the expired stable source as history', async () => {
    const fixture = (await loadCases()).get('mf-h06-special-week-hours')!
    const normalized = normalizeCase(fixture)
    const targetKey = fixture.expected.temporal.heldTargetKeys[0]!
    const targetItemHash = mediaIntakeHash({ targetKey, item: 'special-week-hours' })
    const makeClaim = (input: {
      claimId: string
      observationId: string
      value: string
      claimType: 'STABLE_FACT' | 'TEMPORARY_SCHEDULE'
      authority: 'PUBLIC_SOURCE' | 'HISTORICAL_SOURCE'
      capturedAt: string
      effectiveFrom?: string
      effectiveUntil?: string
    }) => {
      const observation = normalized.observationById.get(input.observationId)!
      const asset = normalized.assets.find((item) => item.sourceId === observation.sourceId)!
      return {
        claimId: input.claimId,
        targetKey,
        targetItemHash,
        claimType: input.claimType,
        value: input.value,
        valueHash: sha256(input.value),
        authority: input.authority,
        consequential: true,
        ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
        ...(input.effectiveUntil ? { effectiveUntil: input.effectiveUntil } : {}),
        source: {
          sourceId: observation.sourceId,
          sourceSha256: asset.sha256,
          sourceVersion: fixture.scope.sourceGeneration,
          capturedAt: input.capturedAt,
          observationIndex: observation.index,
          observationSha256: mediaIntakeHash(observation.value),
        },
      }
    }
    const claims = [
      makeClaim({
        claimId: 'special-week-placard',
        observationId: 'week-placard',
        value: 'September 7-13 open 10 AM-4 PM',
        claimType: 'TEMPORARY_SCHEDULE',
        authority: 'PUBLIC_SOURCE',
        capturedAt: '2026-09-07T12:00:00.000Z',
        effectiveFrom: '2026-09-07T00:00:00.000Z',
        effectiveUntil: '2026-09-14T00:00:00.000Z',
      }),
      makeClaim({
        claimId: 'archived-regular-hours',
        observationId: 'archive-hours',
        value: 'Regular hours are 9 AM-5 PM',
        claimType: 'STABLE_FACT',
        authority: 'HISTORICAL_SOURCE',
        capturedAt: '2025-01-01T12:00:00.000Z',
        effectiveUntil: '2026-09-07T00:00:00.000Z',
      }),
    ]
    const evaluatedAt = '2026-09-10T12:00:00.000Z'
    const reconciliation = reconcileMediaTemporalClaims({ claims, now: evaluatedAt })
    const holds = mediaTemporalHolds(claims, evaluatedAt)
    expect(holds).toEqual([
      { itemHash: targetItemHash, reasons: fixture.expected.temporal.holdReasons },
    ])
    expect(fixture.expected.temporal.outcome).toBe('HELD')
    expect(fixture.expected.temporal.staticCandidateIncludesTarget).toBe(false)
    expect(reconciliation.comparisons[0]!.evidence.map((item) => item.claimId)).toEqual([
      'archived-regular-hours',
      'special-week-placard',
    ])
    expect(reconciliation.claimTemporalDispositions).toContainEqual({
      claimId: 'archived-regular-hours',
      disposition: 'EXPIRED',
    })
  })

  it('binds generation into the evidence receipt and rejects scope or source-hash substitution', async () => {
    const fixture = (await loadCases()).get('mf-d01-exact-exhibit-cross-media')!
    const normalized = normalizeCase(fixture)
    const identifier = fixture.expected.entities.requiredIdentifier!
    const candidates = [candidate(normalized, 'bot-video', ['bot-video-id'], [identifier])]
    const original = validateFrozenEvidence(normalized, candidates)
    const changedGeneration = validateResolutionEvidence({
      scope: normalized.scope,
      sourceGeneration: '90000000-0000-4000-8000-000000000009',
      candidates,
      findings: normalized.findings,
      assets: normalized.assets,
    })
    expect(changedGeneration.evidenceSnapshotHash).not.toBe(original.evidenceSnapshotHash)
    expect(() =>
      validateResolutionEvidence({
        scope: {
          ...normalized.scope,
          uploadAttemptId: '90000000-0000-4000-8000-000000000009',
        },
        sourceGeneration: fixture.scope.sourceGeneration,
        candidates,
        findings: normalized.findings,
        assets: normalized.assets,
      }),
    ).toThrow(/another review scope/u)
    expect(() =>
      validateResolutionEvidence({
        scope: normalized.scope,
        sourceGeneration: fixture.scope.sourceGeneration,
        candidates,
        findings: normalized.findings,
        assets: normalized.assets.map((asset) =>
          asset.sourceId === candidates[0]!.evidence[0]!.sourceId
            ? { ...asset, sha256: 'f'.repeat(64) }
            : asset,
        ),
      }),
    ).toThrow(/changed/u)
  })
})

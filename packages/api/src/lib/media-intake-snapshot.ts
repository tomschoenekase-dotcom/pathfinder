import { createHash } from 'node:crypto'
import { z } from 'zod'

import { VenuePackagePayloadV1 } from '@pathfinder/contracts'
import { MediaTemporalClaimSchema } from '@pathfinder/contracts/media-temporal-claims'
import { mediaTemporalHolds, reconcileMediaTemporalClaims } from './media-temporal-reconciliation'
import {
  MediaResolutionStateSchema,
  projectMediaResolution,
} from '@pathfinder/contracts/media-resolution-state'

import { mediaFindingSchema } from '../routers/admin/media-ingestion-review-schemas'

const id = z.string().min(1).max(191)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const sourceId = z.string().min(1).max(500)
export const MEDIA_INTAKE_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024

export const MediaIntakeBinding = z
  .object({
    kind: z.enum(['place', 'knowledge']),
    itemIndex: z.number().int().min(0).max(499),
    itemHash: sha256,
    sourceIds: z.array(sourceId).min(1).max(20),
    entityRepresentativeId: id.optional(),
  })
  .strict()

export const MediaIntakeHandoffInput = z
  .object({
    tenantId: id,
    venueId: id,
    projectId: id,
    requestId: z.string().uuid(),
    sourceGeneration: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    bindings: z.array(MediaIntakeBinding).min(1).max(500),
    rationale: z.string().trim().min(1).max(2000),
    identityReviewId: z.string().uuid().optional(),
    temporalClaims: z.array(MediaTemporalClaimSchema).min(1).max(100).optional(),
  })
  .strict()

export const MediaIntakeSnapshot = z
  .object({
    kind: z.literal('MEDIA_PROJECT_REVIEW'),
    version: z.literal(1),
    tenantId: id,
    venueId: id,
    projectId: id,
    requestId: z.string().uuid(),
    sourceGeneration: z.string().uuid(),
    reviewedUpdatedAt: z.string().datetime(),
    reviewedBy: id,
    reviewRationale: z.string().trim().min(1).max(2000),
    draft: VenuePackagePayloadV1,
    bindings: z.array(MediaIntakeBinding).min(1).max(500),
    sources: z
      .array(
        z
          .object({
            sourceId,
            assetId: id,
            sha256,
            filename: z.string().min(1).max(1000),
            mediaType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']),
            analysisHash: sha256,
            finding: mediaFindingSchema,
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    identityReview: z
      .object({
        id: z.string().uuid(),
        revision: z.number().int().min(1).max(501),
        state: MediaResolutionStateSchema,
        evidenceSnapshotHash: sha256,
        evidenceSnapshot: z.unknown(),
      })
      .strict()
      .optional(),
    temporalReview: z
      .object({
        claims: z.array(MediaTemporalClaimSchema).min(1).max(100),
        evaluatedAt: z.string().datetime(),
        sourceVersion: id,
        reconciliationHash: sha256,
      })
      .strict()
      .optional(),
  })
  .strict()

export type MediaIntakeSnapshot = z.infer<typeof MediaIntakeSnapshot>

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

/** Hash parsed JSON content; object insertion order never changes source identity. */
export function mediaIntakeHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

export function mediaIntakeSnapshotInput(snapshot: MediaIntakeSnapshot) {
  return MediaIntakeHandoffInput.parse({
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    projectId: snapshot.projectId,
    requestId: snapshot.requestId,
    sourceGeneration: snapshot.sourceGeneration,
    expectedUpdatedAt: snapshot.reviewedUpdatedAt,
    bindings: snapshot.bindings,
    rationale: snapshot.reviewRationale,
    ...(snapshot.identityReview ? { identityReviewId: snapshot.identityReview.id } : {}),
    ...(snapshot.temporalReview ? { temporalClaims: snapshot.temporalReview.claims } : {}),
  })
}

export function mediaIntakeEvidenceLocator(
  snapshot: Pick<MediaIntakeSnapshot, 'tenantId' | 'venueId' | 'projectId' | 'sourceGeneration'>,
  source: string,
) {
  // Hash a tuple so slashes, colons and user filenames cannot alias another source.
  return `media-project-review:v1:${mediaIntakeHash([
    snapshot.tenantId,
    snapshot.venueId,
    snapshot.projectId,
    snapshot.sourceGeneration,
    source,
  ])}`
}

/** Verify the frozen review before creating or consuming its canonical intake proposal. */
export function validateMediaIntakeSnapshot(value: unknown): MediaIntakeSnapshot {
  const serialized = JSON.stringify(value)
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MEDIA_INTAKE_SNAPSHOT_MAX_BYTES) {
    throw new Error(
      'The retained media review is too large; split the review into smaller source groups',
    )
  }
  const snapshot = MediaIntakeSnapshot.parse(value)
  if (snapshot.identityReview) {
    const evidence = snapshot.identityReview.evidenceSnapshot as {
      scope?: unknown
      candidates?: unknown
    } | null
    if (
      !evidence ||
      mediaIntakeHash(snapshot.identityReview.evidenceSnapshot) !==
        snapshot.identityReview.evidenceSnapshotHash ||
      mediaIntakeHash(evidence.scope) !== mediaIntakeHash(snapshot.identityReview.state.scope) ||
      mediaIntakeHash(evidence.candidates) !==
        mediaIntakeHash(snapshot.identityReview.state.candidates) ||
      snapshot.identityReview.state.scope.tenantId !== snapshot.tenantId ||
      snapshot.identityReview.state.scope.projectId !== snapshot.projectId
    )
      throw new Error('Media identity review does not match its retained evidence and scope')
    if (
      (evidence as { sourceGeneration?: unknown }).sourceGeneration !== snapshot.sourceGeneration ||
      snapshot.identityReview.revision !== snapshot.identityReview.state.decisions.length + 1
    )
      throw new Error('Media identity review revision or source generation is inconsistent')
    projectMediaResolution(snapshot.identityReview.state)
  }
  const sources = new Map(snapshot.sources.map((source) => [source.sourceId, source]))
  if (
    sources.size !== snapshot.sources.length ||
    new Set(snapshot.sources.map((source) => source.assetId)).size !== snapshot.sources.length
  ) {
    throw new Error('Media review contains duplicate source identities')
  }
  for (const source of snapshot.sources) {
    if (
      source.finding.sourceId !== source.sourceId ||
      source.finding.filename !== source.filename ||
      source.finding.mediaType !== source.mediaType ||
      mediaIntakeHash(source.finding) !== source.analysisHash
    ) {
      throw new Error('Media review source evidence does not match its retained identity and hash')
    }
  }
  const items = new Set<string>()
  const usedSources = new Set<string>()
  const placeRepresentatives = new Set<string>()
  const groups = snapshot.identityReview
    ? new Map(
        projectMediaResolution(snapshot.identityReview.state).groups.map((group) => [
          group.representativeId,
          group.candidateIds,
        ]),
      )
    : new Map<string, string[]>()
  const candidates = new Map(
    snapshot.identityReview?.state.candidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]) ?? [],
  )
  for (const binding of snapshot.bindings) {
    const item =
      binding.kind === 'place'
        ? snapshot.draft.places[binding.itemIndex]
        : snapshot.draft.knowledgeEntries[binding.itemIndex]
    const key = `${binding.kind}:${binding.itemIndex}`
    if (!item || items.has(key) || mediaIntakeHash(item) !== binding.itemHash) {
      throw new Error('Every reviewed item requires one exact source binding')
    }
    items.add(key)
    if (new Set(binding.sourceIds).size !== binding.sourceIds.length) {
      throw new Error('A reviewed item cannot repeat its source evidence')
    }
    if (binding.entityRepresentativeId) {
      if (!snapshot.identityReview)
        throw new Error('Entity representatives require a retained identity review')
      const members = groups.get(binding.entityRepresentativeId)
      if (!members) throw new Error('Entity representative is outside the retained identity review')
      const expectedSources = new Set(
        members.flatMap(
          (member) => candidates.get(member)?.evidence.map((evidence) => evidence.sourceId) ?? [],
        ),
      )
      for (const member of members) {
        const candidate = candidates.get(member)!
        for (const locator of candidate.evidence) {
          const source = sources.get(locator.sourceId)
          const observations = source?.finding.sourceObservations ?? source?.finding.observations
          if (
            !source ||
            source.sha256 !== locator.sourceSha256 ||
            !observations?.[locator.observationIndex] ||
            mediaIntakeHash(observations[locator.observationIndex]) !== locator.observationSha256
          )
            throw new Error('Entity binding evidence changed from its retained source observation')
        }
      }
      if (
        expectedSources.size !== binding.sourceIds.length ||
        binding.sourceIds.some((source) => !expectedSources.has(source))
      )
        throw new Error('Entity binding must retain every source in the reviewed identity group')
      if (binding.kind === 'place' && placeRepresentatives.has(binding.entityRepresentativeId))
        throw new Error('One reviewed identity group cannot bind multiple place candidates')
      if (binding.kind === 'place') placeRepresentatives.add(binding.entityRepresentativeId)
    }
    for (const source of binding.sourceIds) {
      if (!sources.has(source)) throw new Error('Reviewed item refers to missing source evidence')
      usedSources.add(source)
    }
  }
  if (
    items.size !== snapshot.draft.places.length + snapshot.draft.knowledgeEntries.length ||
    usedSources.size !== sources.size
  ) {
    throw new Error(
      'Media review must bind all candidate items and contain only their retained evidence',
    )
  }
  if (snapshot.temporalReview) {
    const review = snapshot.temporalReview
    const reconciliation = reconcileMediaTemporalClaims({
      claims: review.claims,
      now: review.evaluatedAt,
    })
    if (reconciliation.reconciliationHash !== review.reconciliationHash)
      throw new Error('Temporal review reconciliation does not match its frozen claims and time')
    for (const claim of review.claims) {
      const source = sources.get(claim.source.sourceId)
      const observations = source?.finding.sourceObservations ?? source?.finding.observations
      const observation = observations?.[claim.source.observationIndex]
      if (
        !source ||
        source.sha256 !== claim.source.sourceSha256 ||
        claim.source.sourceVersion !== review.sourceVersion ||
        !observation ||
        mediaIntakeHash(observation) !== claim.source.observationSha256 ||
        !snapshot.bindings.some(
          (binding) =>
            binding.itemHash === claim.targetItemHash &&
            binding.sourceIds.includes(claim.source.sourceId),
        )
      )
        throw new Error(
          'Temporal claim does not match its exact bound item and retained source observation',
        )
    }
    const held = mediaIntakeHeldItemHashes(snapshot)
    if (snapshot.bindings.every((binding) => held.has(binding.itemHash)))
      throw new Error(
        'All reviewed items are held; resolve a local conflict or use the dated operational update workflow',
      )
  }
  return snapshot
}

/** Local holds keep source indices stable and never turn temporary facts into permanent content. */
export function mediaIntakeHeldItemHashes(snapshot: MediaIntakeSnapshot): Set<string> {
  const review = snapshot.temporalReview
  if (!review) return new Set()
  return new Set(mediaTemporalHolds(review.claims, review.evaluatedAt).map((item) => item.itemHash))
}

import { z } from 'zod'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'
import { mediaFindingsSchema } from '../routers/admin/media-ingestion-review-schemas'
import { mediaIntakeHash } from './media-intake-snapshot'
import { reconcileMediaTemporalClaims } from './media-temporal-reconciliation'
import {
  MediaTemporalReceiptInput,
  validateMediaTemporalReviewSnapshot,
} from './media-temporal-review-receipt'

export function captureMediaTemporalReview(params: {
  input: z.input<typeof MediaTemporalReceiptInput>
  actorId: string
  uploadAttemptId: string
  draft: unknown
  findings: unknown
  evaluatedAt: string
  assets: Array<{
    id: string
    sourceId: string
    filename: string
    mediaType: string
    sha256: string | null
    status: string
  }>
}) {
  const input = MediaTemporalReceiptInput.parse(params.input)
  const draft = VenuePackagePayloadV1.parse(params.draft)
  const findings = mediaFindingsSchema.parse(params.findings)
  const findingBySource = new Map(findings.map((finding) => [finding.sourceId, finding]))
  const assetBySource = new Map(params.assets.map((asset) => [asset.sourceId, asset]))
  if (findingBySource.size !== findings.length || assetBySource.size !== params.assets.length)
    throw new Error('Current media evidence contains duplicate source identities.')
  const sourceIds = [...new Set(input.claims.map((claim) => claim.source.sourceId))]
  return validateMediaTemporalReviewSnapshot({
    kind: 'MEDIA_TEMPORAL_REVIEW',
    version: 1,
    tenantId: input.tenantId,
    venueId: input.venueId,
    projectId: input.projectId,
    sourceGeneration: input.sourceGeneration,
    requestId: input.requestId,
    uploadAttemptId: params.uploadAttemptId,
    reviewedUpdatedAt: input.expectedUpdatedAt,
    reviewedBy: params.actorId,
    reviewRationale: input.rationale,
    temporalReview: {
      claims: input.claims,
      evaluatedAt: params.evaluatedAt,
      reconciliationHash: reconcileMediaTemporalClaims({
        claims: input.claims,
        now: params.evaluatedAt,
      }).reconciliationHash,
    },
    items: input.bindings.map((binding) => ({
      binding,
      value:
        binding.kind === 'place'
          ? draft.places[binding.itemIndex]
          : draft.knowledgeEntries[binding.itemIndex],
    })),
    sources: sourceIds.map((sourceId) => {
      const asset = assetBySource.get(sourceId)
      const finding = findingBySource.get(sourceId)
      if (
        !asset ||
        asset.status !== 'COMPLETE' ||
        !asset.sha256 ||
        !finding ||
        asset.filename !== finding.filename ||
        asset.mediaType !== finding.mediaType
      )
        throw new Error('Cited source has no exact complete current asset and finding.')
      const observations = finding.sourceObservations ?? finding.observations
      const indices = [
        ...new Set(
          input.claims
            .filter((claim) => claim.source.sourceId === sourceId)
            .map((claim) => claim.source.observationIndex),
        ),
      ].sort((a, b) => a - b)
      return {
        sourceId,
        assetId: asset.id,
        filename: asset.filename,
        mediaType: asset.mediaType,
        sha256: asset.sha256,
        observations: indices.map((index) => {
          const observation = observations?.[index]
          if (!observation)
            throw new Error('Cited source observation is missing from the current findings.')
          return { index, hash: mediaIntakeHash(observation), value: observation }
        }),
      }
    }),
  })
}

import { z } from 'zod'
import {
  VenuePackagePayloadV1,
  MediaSourceObservationSchema,
  MediaObservationSchema,
} from '@pathfinder/contracts'
import { MediaTemporalClaimSchema } from '@pathfinder/contracts/media-temporal-claims'
import { mediaIntakeHash, MediaIntakeBinding } from './media-intake-snapshot'
import { reconcileMediaTemporalClaims } from './media-temporal-reconciliation'

const id = z.string().trim().min(1).max(191)
const sha = z.string().regex(/^[a-f0-9]{64}$/u)
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
export const MEDIA_TEMPORAL_RECEIPT_MAX_BYTES = 2 * 1024 * 1024
export const MediaTemporalReceiptInput = z
  .object({
    tenantId: id,
    venueId: id,
    projectId: id,
    sourceGeneration: uuid,
    requestId: uuid,
    expectedUpdatedAt: timestamp,
    rationale: z.string().trim().min(1).max(2000),
    claims: z.array(MediaTemporalClaimSchema).min(1).max(100),
    bindings: z
      .array(MediaIntakeBinding.omit({ entityRepresentativeId: true }))
      .min(1)
      .max(100),
  })
  .strict()

export const MediaTemporalReviewSnapshot = z
  .object({
    kind: z.literal('MEDIA_TEMPORAL_REVIEW'),
    version: z.literal(1),
    tenantId: id,
    venueId: id,
    projectId: id,
    sourceGeneration: uuid,
    uploadAttemptId: id,
    requestId: uuid,
    reviewedUpdatedAt: timestamp,
    reviewedBy: id,
    reviewRationale: z.string().trim().min(1).max(2000),
    temporalReview: z
      .object({
        claims: z.array(MediaTemporalClaimSchema).min(1).max(100),
        evaluatedAt: timestamp,
        reconciliationHash: sha,
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            binding: MediaIntakeBinding.omit({ entityRepresentativeId: true }),
            value: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    sources: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(500),
            assetId: id,
            sha256: sha,
            filename: z.string().min(1).max(1000),
            mediaType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']),
            observations: z
              .array(
                z
                  .object({
                    index: z.number().int().min(0),
                    hash: sha,
                    value: z.union([MediaSourceObservationSchema, MediaObservationSchema]),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
export type MediaTemporalReviewSnapshot = z.infer<typeof MediaTemporalReviewSnapshot>

export function mediaTemporalReceiptInput(snapshot: MediaTemporalReviewSnapshot) {
  return MediaTemporalReceiptInput.parse({
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    projectId: snapshot.projectId,
    sourceGeneration: snapshot.sourceGeneration,
    requestId: snapshot.requestId,
    expectedUpdatedAt: snapshot.reviewedUpdatedAt,
    rationale: snapshot.reviewRationale,
    claims: snapshot.temporalReview.claims,
    bindings: snapshot.items.map((item) => item.binding),
  })
}

/** Independent immutable evidence review; every item may be held without creating a Builder run. */
export function validateMediaTemporalReviewSnapshot(value: unknown): MediaTemporalReviewSnapshot {
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > MEDIA_TEMPORAL_RECEIPT_MAX_BYTES)
    throw new Error('Temporal review exceeds its compact receipt limit.')
  const snapshot = MediaTemporalReviewSnapshot.parse(value)
  const sourceMap = new Map(snapshot.sources.map((source) => [source.sourceId, source]))
  const itemMap = new Map(snapshot.items.map((item) => [item.binding.itemHash, item]))
  if (
    sourceMap.size !== snapshot.sources.length ||
    itemMap.size !== snapshot.items.length ||
    new Set(snapshot.sources.map((source) => source.assetId)).size !== snapshot.sources.length ||
    new Set(snapshot.items.map((item) => `${item.binding.kind}:${item.binding.itemIndex}`)).size !==
      snapshot.items.length
  )
    throw new Error('Temporal review contains duplicate source or target identities.')
  for (const item of snapshot.items) {
    const citedSources = new Set(
      snapshot.temporalReview.claims
        .filter((claim) => claim.targetItemHash === item.binding.itemHash)
        .map((claim) => claim.source.sourceId),
    )
    const parsed = VenuePackagePayloadV1.parse({
      schemaVersion: 1,
      places: item.binding.kind === 'place' ? [item.value] : [],
      knowledgeEntries: item.binding.kind === 'knowledge' ? [item.value] : [],
    })
    const normalized = item.binding.kind === 'place' ? parsed.places[0] : parsed.knowledgeEntries[0]
    if (
      mediaIntakeHash(normalized) !== item.binding.itemHash ||
      new Set(item.binding.sourceIds).size !== item.binding.sourceIds.length ||
      citedSources.size !== item.binding.sourceIds.length ||
      item.binding.sourceIds.some((sourceId) => !citedSources.has(sourceId))
    )
      throw new Error('Temporal item does not match its exact normalized draft value.')
  }
  for (const source of snapshot.sources) {
    if (
      new Set(source.observations.map((entry) => entry.index)).size !==
        source.observations.length ||
      source.observations.some((entry) => mediaIntakeHash(entry.value) !== entry.hash)
    )
      throw new Error('Temporal observation does not match its retained index and hash.')
  }
  const usedItems = new Set<string>()
  const usedObservations = new Set<string>()
  for (const claim of snapshot.temporalReview.claims) {
    const source = sourceMap.get(claim.source.sourceId)
    const item = itemMap.get(claim.targetItemHash)
    const observation = source?.observations.find(
      (entry) => entry.index === claim.source.observationIndex,
    )
    if (
      !source ||
      !item ||
      !observation ||
      source.sha256 !== claim.source.sourceSha256 ||
      claim.source.sourceVersion !== snapshot.uploadAttemptId ||
      observation.hash !== claim.source.observationSha256 ||
      !item.binding.sourceIds.includes(source.sourceId)
    )
      throw new Error('Temporal claim is outside its exact bound item and source observation.')
    usedItems.add(item.binding.itemHash)
    usedObservations.add(JSON.stringify([source.sourceId, observation.index]))
  }
  if (
    usedItems.size !== snapshot.items.length ||
    snapshot.sources.some((source) =>
      source.observations.some(
        (entry) => !usedObservations.has(JSON.stringify([source.sourceId, entry.index])),
      ),
    )
  )
    throw new Error('Compact temporal evidence must contain only cited items and observations.')
  if (
    reconcileMediaTemporalClaims({
      claims: snapshot.temporalReview.claims,
      now: snapshot.temporalReview.evaluatedAt,
    }).reconciliationHash !== snapshot.temporalReview.reconciliationHash
  )
    throw new Error('Temporal reconciliation changed from its frozen claim set and time.')
  return snapshot
}

import { createHash } from 'node:crypto'
import { z } from 'zod'

import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

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
  return snapshot
}

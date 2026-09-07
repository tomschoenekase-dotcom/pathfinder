import { z } from 'zod'

import { VenuePackagePayloadV1 } from '@pathfinder/contracts'
import {
  MediaTemporalClaimSchema,
  type MediaTemporalClaim,
} from '@pathfinder/contracts/media-temporal-claims'
import { db } from '@pathfinder/db'

import { mediaIntakeHash } from './media-intake-snapshot'
import { reconcileMediaTemporalClaims } from './media-temporal-reconciliation'
import { mediaFindingsSchema } from '../routers/admin/media-ingestion-review-schemas'

const id = z.string().min(1).max(191)
export const MEDIA_TEMPORAL_REVIEW_MAX_BYTES = 1024 * 1024
export const MEDIA_TEMPORAL_REVIEW_CLAIM_LIMIT = 100
export const MEDIA_TEMPORAL_REVIEW_COMPARISON_LIMIT = 50

export const MediaTemporalReviewInput = z
  .object({
    tenantId: id,
    venueId: id,
    projectId: id,
    sourceGeneration: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    expectedUpdatedAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    claims: z.array(MediaTemporalClaimSchema).min(1).max(MEDIA_TEMPORAL_REVIEW_CLAIM_LIMIT),
  })
  .strict()

export class MediaTemporalReviewError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_EVIDENCE' | 'TOO_LARGE',
    message: string,
  ) {
    super(message)
    this.name = 'MediaTemporalReviewError'
  }
}

export type MediaTemporalReviewClient = Pick<typeof db, '$transaction'>

type ProjectRow = {
  id: string
  status: string
  stage: string
  updatedAt: Date
  sourceGeneration: string | null
  uploadAttemptId: string | null
  sourceObjectKey: string | null
  draftJson: unknown
  findings: unknown
}

function itemSummary(kind: 'place' | 'knowledge', itemIndex: number, item: unknown) {
  const record = item as { name?: string; title?: string }
  return {
    kind,
    itemIndex,
    itemHash: mediaIntakeHash(item),
    label: (record.name ?? record.title ?? `${kind} ${itemIndex + 1}`).slice(0, 255),
  }
}

async function readTemporalReview(
  tx: typeof db,
  input: z.output<typeof MediaTemporalReviewInput>,
  evaluatedAt: string,
) {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MEDIA_TEMPORAL_REVIEW_MAX_BYTES)
    throw new MediaTemporalReviewError('TOO_LARGE', 'Temporal review request is too large.')

  const projects = await tx.$queryRaw<ProjectRow[]>`
    SELECT id, status, stage, updated_at AS "updatedAt",
      source_object_generation::text AS "sourceGeneration",
      upload_attempt_id AS "uploadAttemptId",
      source_object_key AS "sourceObjectKey",
      CASE WHEN octet_length(draft_json::text) <= 8388608 THEN draft_json ELSE NULL END AS "draftJson",
      CASE WHEN octet_length(findings::text) <= 8388608 THEN findings ELSE NULL END AS findings
    FROM media_ingestion_projects
    WHERE id = ${input.projectId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
    LIMIT 1
  `
  const project = projects[0]
  if (!project) throw new MediaTemporalReviewError('NOT_FOUND', 'Media project not found.')
  if (
    project.status !== 'READY_FOR_REVIEW' ||
    project.stage !== 'review' ||
    project.sourceGeneration !== input.sourceGeneration ||
    project.updatedAt.toISOString() !== input.expectedUpdatedAt
  )
    throw new MediaTemporalReviewError(
      'CONFLICT',
      'The reviewed media project changed or is not ready for temporal review.',
    )
  if (!project.draftJson || !project.findings)
    throw new MediaTemporalReviewError('TOO_LARGE', 'Reviewed media evidence exceeds the limit.')
  if (!project.sourceObjectKey)
    throw new MediaTemporalReviewError(
      'INVALID_EVIDENCE',
      'Current source identity is unavailable.',
    )

  const draft = VenuePackagePayloadV1.parse(project.draftJson)
  const findings = mediaFindingsSchema.parse(project.findings)
  const sourceIds = [...new Set(input.claims.map((claim) => claim.source.sourceId))]
  const assets = await tx.mediaIngestionAsset.findMany({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      sourceId: { in: sourceIds },
      status: 'COMPLETE',
      sha256: { not: null },
      objectKey: { startsWith: `${project.sourceObjectKey}#` },
    },
    select: { sourceId: true, sha256: true },
    take: MEDIA_TEMPORAL_REVIEW_CLAIM_LIMIT + 1,
  })
  const assetsBySource = new Map(assets.map((asset) => [asset.sourceId, asset]))
  if (assetsBySource.size !== assets.length)
    throw new MediaTemporalReviewError(
      'INVALID_EVIDENCE',
      'Reviewed assets contain duplicate source identities.',
    )
  const findingsBySource = new Map(findings.map((finding) => [finding.sourceId, finding]))
  if (findingsBySource.size !== findings.length)
    throw new MediaTemporalReviewError(
      'INVALID_EVIDENCE',
      'Reviewed findings contain duplicate source identities.',
    )

  const items = [
    ...draft.places.map((item, index) => itemSummary('place', index, item)),
    ...draft.knowledgeEntries.map((item, index) => itemSummary('knowledge', index, item)),
  ]
  const itemHashes = new Set(items.map((item) => item.itemHash))
  const reviewAssertions: Array<{
    claimId: string
    assertedAuthority: MediaTemporalClaim['authority']
    authorityStatus: 'REVIEW_ASSERTED'
  }> = []
  const normalizedClaims = input.claims.map((claim) => {
    const asset = assetsBySource.get(claim.source.sourceId)
    const finding = findingsBySource.get(claim.source.sourceId)
    const observations = finding?.sourceObservations ?? finding?.observations
    const observation = observations?.[claim.source.observationIndex]
    if (
      !asset?.sha256 ||
      asset.sha256 !== claim.source.sourceSha256 ||
      !project.uploadAttemptId ||
      project.uploadAttemptId !== claim.source.sourceVersion ||
      !finding ||
      !observation ||
      mediaIntakeHash(observation) !== claim.source.observationSha256 ||
      !itemHashes.has(claim.targetItemHash)
    )
      throw new MediaTemporalReviewError(
        'INVALID_EVIDENCE',
        `Temporal claim ${claim.claimId} does not match current reviewed source evidence and draft identity.`,
      )
    reviewAssertions.push({
      claimId: claim.claimId,
      assertedAuthority: claim.authority,
      authorityStatus: 'REVIEW_ASSERTED',
    })
    return claim
  })

  const reconciliation = reconcileMediaTemporalClaims({
    claims: normalizedClaims,
    now: evaluatedAt,
  })
  const blocked = new Map<string, string[]>()
  for (const comparison of reconciliation.comparisons) {
    if (!reconciliation.blockedTargetKeys.includes(comparison.targetKey)) continue
    for (const claim of normalizedClaims.filter(
      (entry) => entry.targetKey === comparison.targetKey,
    ))
      blocked.set(claim.targetItemHash, [
        ...(blocked.get(claim.targetItemHash) ?? []),
        comparison.targetKey,
      ])
  }
  const comparisonCount = reconciliation.comparisons.length
  return {
    evaluatedAt,
    authorityBasis: 'REVIEW_ASSERTED' as const,
    authorityVerified: false as const,
    reviewAssertions,
    reconciliation: {
      ...reconciliation,
      comparisons: reconciliation.comparisons.slice(0, MEDIA_TEMPORAL_REVIEW_COMPARISON_LIMIT),
      comparisonCount,
      comparisonsTruncated: comparisonCount > MEDIA_TEMPORAL_REVIEW_COMPARISON_LIMIT,
    },
    reviewReceiptHash: mediaIntakeHash({ input, evaluatedAt, reconciliation }),
    items: items.map((item) => ({
      ...item,
      status: blocked.has(item.itemHash) ? ('LOCALLY_BLOCKED' as const) : ('ELIGIBLE' as const),
      blockedTargetKeys: [...new Set(blocked.get(item.itemHash) ?? [])].sort(),
    })),
  }
}

export async function previewMediaTemporalReview(params: {
  db: MediaTemporalReviewClient
  input: z.input<typeof MediaTemporalReviewInput>
  evaluatedAt: string
}) {
  const input = MediaTemporalReviewInput.parse(params.input)
  const evaluatedAt = new Date(
    z.string().datetime({ offset: true }).parse(params.evaluatedAt),
  ).toISOString()
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MEDIA_TEMPORAL_REVIEW_MAX_BYTES)
    throw new MediaTemporalReviewError('TOO_LARGE', 'Temporal review request is too large.')
  return params.db.$transaction(
    (rawTx) => readTemporalReview(rawTx as unknown as typeof db, input, evaluatedAt),
    { isolationLevel: 'RepeatableRead' },
  )
}

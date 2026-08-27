import { createHash } from 'node:crypto'

import type {
  ApprovedVenueMediaCandidate,
  RegisterVenueMediaAssetInput,
  RequestVenueMediaDerivativesInput,
  ReviewVenueMediaAssetInput,
} from '@pathfinder/contracts'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type VenueMediaHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type VenueMediaActionErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT'

export class VenueMediaActionError extends Error {
  constructor(
    readonly code: VenueMediaActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VenueMediaActionError'
  }
}

export type VenueMediaActionClient = Pick<
  typeof db,
  '$transaction' | 'venueMediaAsset' | 'venueMediaDerivative'
>

function assertActor(actor: VenueMediaHumanActor): void {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id.trim()) {
    throw new VenueMediaActionError(
      'INVALID_INPUT',
      'A signed-in human platform administrator is required.',
    )
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function hasRequiredVerificationReceipts(
  receipts: Array<{ kind: string; verdict: string; objectGeneration: string }>,
  objectGeneration: string,
): boolean {
  const exact = receipts.filter((receipt) => receipt.objectGeneration === objectGeneration)
  return (
    exact.some((receipt) => receipt.kind === 'PRECHECK' && receipt.verdict === 'PASSED') &&
    exact.some((receipt) => receipt.kind === 'MALWARE' && receipt.verdict === 'CLEAN')
  )
}

export async function registerVenueMediaAssetAction(input: {
  db?: VenueMediaActionClient
  registration: RegisterVenueMediaAssetInput
  actor: VenueMediaHumanActor
}): Promise<{ assetId: string; reviewState: 'UNREVIEWED'; delivery: 'NOT_AVAILABLE' }> {
  assertActor(input.actor)
  const registration = input.registration
  try {
    return await (input.db ?? db).$transaction(async (tx) => {
      const venue = await tx.venue.findFirst({
        where: { id: registration.venueId, tenantId: registration.tenantId },
        select: { id: true },
      })
      if (!venue) throw new VenueMediaActionError('NOT_FOUND', 'Venue not found.')

      const upload = await tx.intakeUpload.findFirst({
        where: {
          id: registration.intakeUploadId,
          tenantId: registration.tenantId,
          venueId: registration.venueId,
        },
        select: {
          id: true,
          status: true,
          category: true,
          mimeType: true,
          verifiedAt: true,
          objectGeneration: true,
          verificationReceipts: {
            select: { kind: true, verdict: true, objectGeneration: true },
          },
        },
      })
      if (!upload) {
        throw new VenueMediaActionError('NOT_FOUND', 'Verified venue media upload not found.')
      }
      if (
        upload.status !== 'AWAITING_REVIEW' ||
        !upload.verifiedAt ||
        !['PHOTO', 'FLOOR_PLAN'].includes(upload.category) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(upload.mimeType) ||
        !hasRequiredVerificationReceipts(upload.verificationReceipts, upload.objectGeneration)
      ) {
        throw new VenueMediaActionError(
          'INVALID_INPUT',
          'Media registration requires an exact, browser-safe image upload with passed precheck and clean malware evidence.',
        )
      }

      if (registration.linkedPlaceIds.length) {
        const places = await tx.place.findMany({
          where: {
            tenantId: registration.tenantId,
            venueId: registration.venueId,
            id: { in: registration.linkedPlaceIds },
          },
          select: { id: true },
        })
        if (places.length !== registration.linkedPlaceIds.length) {
          throw new VenueMediaActionError(
            'INVALID_INPUT',
            'Every linked Place must belong to this exact tenant and venue.',
          )
        }
      }
      if (registration.linkedKnowledgeEntryIds.length) {
        const entries = await tx.venueKnowledgeEntry.findMany({
          where: {
            tenantId: registration.tenantId,
            venueId: registration.venueId,
            id: { in: registration.linkedKnowledgeEntryIds },
          },
          select: { id: true },
        })
        if (entries.length !== registration.linkedKnowledgeEntryIds.length) {
          throw new VenueMediaActionError(
            'INVALID_INPUT',
            'Every linked knowledge entry must belong to this exact tenant and venue.',
          )
        }
      }

      await tx.venueMediaAsset.create({
        data: {
          id: registration.assetId,
          tenantId: registration.tenantId,
          venueId: registration.venueId,
          intakeUploadId: registration.intakeUploadId,
          kind: registration.kind,
          semanticDescription: registration.semanticDescription,
          depictedSubjects: registration.depictedSubjects,
          altText: registration.altText,
          caption: registration.caption ?? null,
          usageGuidance: registration.usageGuidance ?? null,
          importance: registration.importance,
          sourceName: registration.sourceName,
          sourceUrl: registration.sourceUrl ?? null,
          sourceCapturedAt: registration.sourceCapturedAt
            ? new Date(registration.sourceCapturedAt)
            : null,
          createdBy: input.actor.id,
          placeLinks: {
            create: registration.linkedPlaceIds.map((placeId) => ({
              tenantId: registration.tenantId,
              venueId: registration.venueId,
              placeId,
            })),
          },
          knowledgeLinks: {
            create: registration.linkedKnowledgeEntryIds.map((knowledgeEntryId) => ({
              tenantId: registration.tenantId,
              venueId: registration.venueId,
              knowledgeEntryId,
            })),
          },
        },
        select: { id: true },
      })
      await writeAuditLogStrict(
        {
          tenantId: registration.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'venue_media.registered',
          targetType: 'VenueMediaAsset',
          targetId: registration.assetId,
          afterState: {
            venueId: registration.venueId,
            kind: registration.kind,
            intakeUploadId: registration.intakeUploadId,
            reviewState: 'UNREVIEWED',
            visitorDelivery: 'NOT_AVAILABLE',
          },
        },
        tx,
      )
      return {
        assetId: registration.assetId,
        reviewState: 'UNREVIEWED' as const,
        delivery: 'NOT_AVAILABLE' as const,
      }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueMediaActionError(
        'CONFLICT',
        'This asset or upload has already been registered; refresh before retrying.',
      )
    }
    throw error
  }
}

type ReviewReplay = {
  id: string
  venueId: string
  assetId: string
  sequence: number
  action: 'APPROVE_CONTENT_USE' | 'WITHDRAW_CONTENT_USE'
  actorId: string
  rightsBasis: 'VENUE_OWNED' | 'LICENSED' | 'PERMISSION_GRANTED' | 'PUBLIC_DOMAIN' | null
  rightsStatement: string | null
  rightsEvidenceSourceId: string | null
  reason: string | null
}

function replayReview(
  existing: ReviewReplay,
  input: ReviewVenueMediaAssetInput,
  actorId: string,
): { reviewId: string; sequence: number; action: ReviewReplay['action']; replayed: true } {
  const sameActionDetails =
    input.action === 'APPROVE_CONTENT_USE'
      ? existing.rightsBasis === input.rightsBasis &&
        existing.rightsStatement === input.rightsStatement &&
        existing.rightsEvidenceSourceId === input.rightsEvidenceSourceId &&
        existing.reason === null
      : existing.rightsBasis === null &&
        existing.rightsStatement === null &&
        existing.rightsEvidenceSourceId === null &&
        existing.reason === input.reason
  if (
    existing.venueId !== input.venueId ||
    existing.assetId !== input.assetId ||
    existing.sequence !== input.expectedLatestSequence + 1 ||
    existing.action !== input.action ||
    existing.actorId !== actorId ||
    !sameActionDetails
  ) {
    throw new VenueMediaActionError(
      'CONFLICT',
      'This review request key belongs to a different action.',
    )
  }
  return {
    reviewId: existing.id,
    sequence: existing.sequence,
    action: existing.action,
    replayed: true,
  }
}

export async function reviewVenueMediaAssetAction(input: {
  db?: VenueMediaActionClient
  review: ReviewVenueMediaAssetInput
  actor: VenueMediaHumanActor
}): Promise<{
  reviewId: string
  sequence: number
  action: 'APPROVE_CONTENT_USE' | 'WITHDRAW_CONTENT_USE'
  replayed: boolean
  delivery: 'CONTROLLED_DERIVATIVE_REQUIRED'
}> {
  assertActor(input.actor)
  const review = input.review
  try {
    return await (input.db ?? db).$transaction(async (tx) => {
      const existingRequest = await tx.venueMediaReview.findFirst({
        where: { tenantId: review.tenantId, requestId: review.requestId },
        select: {
          id: true,
          venueId: true,
          assetId: true,
          sequence: true,
          action: true,
          actorId: true,
          rightsBasis: true,
          rightsStatement: true,
          rightsEvidenceSourceId: true,
          reason: true,
        },
      })
      if (existingRequest) {
        return {
          ...replayReview(existingRequest, review, input.actor.id),
          delivery: 'CONTROLLED_DERIVATIVE_REQUIRED' as const,
        }
      }
      const asset = await tx.venueMediaAsset.findFirst({
        where: { id: review.assetId, tenantId: review.tenantId, venueId: review.venueId },
        select: {
          id: true,
          reviews: {
            orderBy: { sequence: 'desc' },
            take: 1,
            select: { sequence: true, action: true },
          },
        },
      })
      if (!asset) throw new VenueMediaActionError('NOT_FOUND', 'Venue media asset not found.')
      const latest = asset.reviews[0]
      const latestSequence = latest?.sequence ?? 0
      if (latestSequence !== review.expectedLatestSequence) {
        throw new VenueMediaActionError(
          'CONFLICT',
          `Latest review sequence is ${latestSequence}, not ${review.expectedLatestSequence}.`,
        )
      }
      if (review.action === 'WITHDRAW_CONTENT_USE' && latest?.action !== 'APPROVE_CONTENT_USE') {
        throw new VenueMediaActionError(
          'INVALID_INPUT',
          'Only a currently approved asset can be withdrawn.',
        )
      }
      const created = await tx.venueMediaReview.create({
        data: {
          tenantId: review.tenantId,
          venueId: review.venueId,
          assetId: review.assetId,
          sequence: latestSequence + 1,
          action: review.action,
          rightsBasis: review.action === 'APPROVE_CONTENT_USE' ? review.rightsBasis : null,
          rightsStatement: review.action === 'APPROVE_CONTENT_USE' ? review.rightsStatement : null,
          rightsEvidenceSourceId:
            review.action === 'APPROVE_CONTENT_USE' ? review.rightsEvidenceSourceId : null,
          reason: review.action === 'WITHDRAW_CONTENT_USE' ? review.reason : null,
          requestId: review.requestId,
          actorId: input.actor.id,
        },
        select: { id: true, sequence: true },
      })
      await writeAuditLogStrict(
        {
          tenantId: review.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action:
            review.action === 'APPROVE_CONTENT_USE'
              ? 'venue_media.content_use_approved'
              : 'venue_media.content_use_withdrawn',
          targetType: 'VenueMediaAsset',
          targetId: review.assetId,
          beforeState: {
            latestReviewSequence: latestSequence,
            state: latest?.action ?? 'UNREVIEWED',
          },
          afterState: {
            venueId: review.venueId,
            latestReviewSequence: created.sequence,
            state: review.action,
            visitorDelivery: 'CONTROLLED_DERIVATIVE_REQUIRED',
          },
        },
        tx,
      )
      return {
        reviewId: created.id,
        sequence: created.sequence,
        action: review.action,
        replayed: false,
        delivery: 'CONTROLLED_DERIVATIVE_REQUIRED' as const,
      }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await (input.db ?? db).venueMediaAsset.findFirst({
        where: { id: review.assetId, tenantId: review.tenantId, venueId: review.venueId },
        select: {
          reviews: {
            where: { requestId: review.requestId },
            take: 1,
            select: {
              id: true,
              venueId: true,
              assetId: true,
              sequence: true,
              action: true,
              actorId: true,
              rightsBasis: true,
              rightsStatement: true,
              rightsEvidenceSourceId: true,
              reason: true,
            },
          },
        },
      })
      const raced = existing?.reviews[0]
      if (raced) {
        return {
          ...replayReview(raced, review, input.actor.id),
          delivery: 'CONTROLLED_DERIVATIVE_REQUIRED' as const,
        }
      }
      throw new VenueMediaActionError('CONFLICT', 'The media review state changed concurrently.')
    }
    throw error
  }
}

export async function resolveApprovedVenueMediaCandidates(input: {
  db?: VenueMediaActionClient
  tenantId: string
  venueId: string
  maximumAssets?: number
}): Promise<ApprovedVenueMediaCandidate[]> {
  const maximumAssets = input.maximumAssets ?? 20
  if (
    !input.tenantId.trim() ||
    !input.venueId.trim() ||
    !Number.isInteger(maximumAssets) ||
    maximumAssets < 1 ||
    maximumAssets > 50
  ) {
    throw new VenueMediaActionError(
      'INVALID_INPUT',
      'Exact scope and a 1-50 asset bound are required.',
    )
  }
  const rows = await (input.db ?? db).venueMediaAsset.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: maximumAssets + 1,
    select: {
      id: true,
      kind: true,
      semanticDescription: true,
      depictedSubjects: true,
      altText: true,
      caption: true,
      usageGuidance: true,
      importance: true,
      intakeUpload: {
        select: {
          status: true,
          verifiedAt: true,
          objectGeneration: true,
          verificationReceipts: {
            select: { kind: true, verdict: true, objectGeneration: true },
          },
        },
      },
      placeLinks: { select: { placeId: true } },
      knowledgeLinks: { select: { knowledgeEntryId: true } },
      reviews: {
        orderBy: { sequence: 'desc' },
        take: 1,
        select: { action: true, rightsBasis: true },
      },
    },
  })
  if (rows.length > maximumAssets) {
    throw new VenueMediaActionError(
      'CONFLICT',
      'Approved media candidate count exceeds safe bounds.',
    )
  }
  return rows
    .filter((row) => {
      const latest = row.reviews[0]
      return (
        latest?.action === 'APPROVE_CONTENT_USE' &&
        latest.rightsBasis !== null &&
        row.intakeUpload.status === 'AWAITING_REVIEW' &&
        row.intakeUpload.verifiedAt !== null &&
        hasRequiredVerificationReceipts(
          row.intakeUpload.verificationReceipts,
          row.intakeUpload.objectGeneration,
        )
      )
    })
    .map((row) => ({
      assetId: row.id,
      kind: row.kind,
      semanticDescription: row.semanticDescription,
      depictedSubjects: row.depictedSubjects,
      altText: row.altText,
      caption: row.caption,
      usageGuidance: row.usageGuidance,
      importance: row.importance,
      linkedPlaceIds: row.placeLinks.map((link) => link.placeId).sort(),
      linkedKnowledgeEntryIds: row.knowledgeLinks.map((link) => link.knowledgeEntryId).sort(),
      delivery: 'CONTROLLED_DERIVATIVE_REQUIRED' as const,
    }))
}

type DerivativeRequestResult = {
  derivativeId: string
  variant: 'CARD' | 'DETAIL'
  status: 'PENDING' | 'READY' | 'FAILED'
}

function derivativeRequestHash(request: RequestVenueMediaDerivativesInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'torchiko-venue-media-derivative-request-v1',
        request.tenantId,
        request.venueId,
        request.assetId,
        request.expectedLatestReviewSequence,
        [...request.variants].sort(),
      ]),
    )
    .digest('hex')
}

function replayDerivativeRequest(
  rows: Array<{
    id: string
    venueId: string
    assetId: string
    requestHash: string
    variant: 'CARD' | 'DETAIL'
    status: 'PENDING' | 'READY' | 'FAILED'
  }>,
  request: RequestVenueMediaDerivativesInput,
  requestHash: string,
): DerivativeRequestResult[] {
  const expectedVariants = [...request.variants].sort()
  const actualVariants = rows.map((row) => row.variant).sort()
  if (
    rows.some(
      (row) =>
        row.venueId !== request.venueId ||
        row.assetId !== request.assetId ||
        row.requestHash !== requestHash,
    ) ||
    JSON.stringify(actualVariants) !== JSON.stringify(expectedVariants)
  ) {
    throw new VenueMediaActionError(
      'CONFLICT',
      'This derivative request key belongs to a different exact request.',
    )
  }
  return rows
    .map((row) => ({ derivativeId: row.id, variant: row.variant, status: row.status }))
    .sort((left, right) => left.variant.localeCompare(right.variant))
}

export async function requestVenueMediaDerivativesAction(input: {
  db?: VenueMediaActionClient
  request: RequestVenueMediaDerivativesInput
  actor: VenueMediaHumanActor
}): Promise<{ items: DerivativeRequestResult[]; replayed: boolean }> {
  assertActor(input.actor)
  const request = input.request
  const requestHash = derivativeRequestHash(request)
  const client = input.db ?? db

  try {
    return await client.$transaction(async (tx) => {
      const replay = await tx.venueMediaDerivative.findMany({
        where: { tenantId: request.tenantId, requestId: request.requestId },
        select: {
          id: true,
          venueId: true,
          assetId: true,
          requestHash: true,
          variant: true,
          status: true,
        },
      })
      if (replay.length) {
        return { items: replayDerivativeRequest(replay, request, requestHash), replayed: true }
      }

      const asset = await tx.venueMediaAsset.findFirst({
        where: { id: request.assetId, tenantId: request.tenantId, venueId: request.venueId },
        select: {
          id: true,
          intakeUpload: {
            select: {
              status: true,
              verifiedAt: true,
              objectGeneration: true,
              storageVersionId: true,
              verificationReceipts: {
                select: { kind: true, verdict: true, objectGeneration: true },
              },
            },
          },
          reviews: {
            orderBy: { sequence: 'desc' },
            take: 1,
            select: { sequence: true, action: true, rightsBasis: true },
          },
        },
      })
      if (!asset) throw new VenueMediaActionError('NOT_FOUND', 'Venue media asset not found.')
      const latest = asset.reviews[0]
      if (latest?.sequence !== request.expectedLatestReviewSequence) {
        throw new VenueMediaActionError(
          'CONFLICT',
          `Latest review sequence is ${latest?.sequence ?? 0}, not ${request.expectedLatestReviewSequence}.`,
        )
      }
      if (latest.action !== 'APPROVE_CONTENT_USE' || latest.rightsBasis === null) {
        throw new VenueMediaActionError(
          'INVALID_INPUT',
          'Controlled derivatives require a currently approved rights review.',
        )
      }
      const upload = asset.intakeUpload
      if (
        upload.status !== 'AWAITING_REVIEW' ||
        upload.verifiedAt === null ||
        !upload.storageVersionId ||
        !hasRequiredVerificationReceipts(upload.verificationReceipts, upload.objectGeneration)
      ) {
        throw new VenueMediaActionError(
          'INVALID_INPUT',
          'Controlled derivatives require the exact verified immutable source object.',
        )
      }

      await tx.venueMediaDerivative.createMany({
        data: request.variants.map((variant) => ({
          tenantId: request.tenantId,
          venueId: request.venueId,
          assetId: request.assetId,
          requestId: request.requestId,
          requestHash,
          variant,
          sourceObjectGeneration: upload.objectGeneration,
          sourceStorageVersionId: upload.storageVersionId!,
          approvedReviewSequence: request.expectedLatestReviewSequence,
          createdBy: input.actor.id,
        })),
      })
      const created = await tx.venueMediaDerivative.findMany({
        where: { tenantId: request.tenantId, requestId: request.requestId },
        select: {
          id: true,
          venueId: true,
          assetId: true,
          requestHash: true,
          variant: true,
          status: true,
        },
      })
      const items = replayDerivativeRequest(created, request, requestHash)
      await writeAuditLogStrict(
        {
          tenantId: request.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'venue_media.derivatives_requested',
          targetType: 'VenueMediaAsset',
          targetId: request.assetId,
          afterState: {
            venueId: request.venueId,
            requestId: request.requestId,
            requestHash,
            variants: items.map((item) => item.variant),
            delivery: 'NOT_AVAILABLE_UNTIL_READY',
          },
        },
        tx,
      )
      return { items, replayed: false }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raced = await client.venueMediaDerivative.findMany({
        where: { tenantId: request.tenantId, requestId: request.requestId },
        select: {
          id: true,
          venueId: true,
          assetId: true,
          requestHash: true,
          variant: true,
          status: true,
        },
      })
      if (raced.length) {
        return { items: replayDerivativeRequest(raced, request, requestHash), replayed: true }
      }
      throw new VenueMediaActionError(
        'CONFLICT',
        'A controlled derivative already exists for this exact source and variant.',
      )
    }
    throw error
  }
}

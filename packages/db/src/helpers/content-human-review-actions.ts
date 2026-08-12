import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type ContentHumanReviewEntityType = 'PLACE' | 'KNOWLEDGE_ENTRY'

export type ContentHumanReviewActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type ContentHumanReviewErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT'

export class ContentHumanReviewError extends Error {
  constructor(
    readonly code: ContentHumanReviewErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ContentHumanReviewError'
  }
}

export type ContentHumanReviewProvenanceRepair = {
  sourceType?: string | undefined
  sourceName?: string | undefined
  sourceUrl?: string | undefined
}

export type ContentHumanReviewClient = Pick<typeof db, '$transaction'>

type ReviewRow = {
  id: string
  updatedAt: Date
  lastReviewedAt: Date | null
  lastReviewedBy: string | null
  humanConfirmedAt: Date | null
  humanConfirmedBy: string | null
  sourceType: string
  sourceName: string | null
  sourceUrl: string | null
}

function invalid(message: string): never {
  throw new ContentHumanReviewError('INVALID_INPUT', message)
}

function assertActor(actor: ContentHumanReviewActor): void {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id.trim()) {
    invalid('A signed-in human platform administrator is required.')
  }
}

function validateRepair(
  repair: ContentHumanReviewProvenanceRepair | undefined,
): ContentHumanReviewProvenanceRepair | undefined {
  if (!repair) return undefined
  const normalized: ContentHumanReviewProvenanceRepair = {}
  if (repair.sourceType !== undefined) {
    const sourceType = repair.sourceType.trim()
    if (!sourceType || sourceType.length > 64 || sourceType === 'UNKNOWN') {
      invalid('A repaired source type must be known and at most 64 characters.')
    }
    normalized.sourceType = sourceType
  }
  if (repair.sourceName !== undefined) {
    const sourceName = repair.sourceName.trim()
    if (!sourceName || sourceName.length > 200) {
      invalid('A repaired source name must be between 1 and 200 characters.')
    }
    normalized.sourceName = sourceName
  }
  if (repair.sourceUrl !== undefined) {
    const sourceUrl = repair.sourceUrl.trim()
    if (!sourceUrl || sourceUrl.length > 2_000) invalid('A repaired source URL is invalid.')
    let url: URL
    try {
      url = new URL(sourceUrl)
    } catch {
      invalid('A repaired source URL is invalid.')
    }
    const credentialShapedKey = [
      ...url.searchParams.keys(),
      ...new URLSearchParams(url.hash.slice(1)).keys(),
    ].some((key) =>
      /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu.test(key),
    )
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search.includes('%') ||
      url.hash.includes('%') ||
      credentialShapedKey
    ) {
      invalid('A repaired source URL must be HTTP(S) and contain no credentials or signed tokens.')
    }
    normalized.sourceUrl = url.toString()
  }
  if (Object.keys(normalized).length === 0) {
    invalid('A provenance repair must contain at least one validated field.')
  }
  return normalized
}

function changedProvenanceFields(
  before: ReviewRow,
  repair: ContentHumanReviewProvenanceRepair | undefined,
): string[] {
  if (!repair) return []
  const changed: string[] = []
  if (repair.sourceType !== undefined && repair.sourceType !== before.sourceType) {
    changed.push('sourceType')
  }
  if (repair.sourceName !== undefined && repair.sourceName !== before.sourceName) {
    changed.push('sourceName')
  }
  if (repair.sourceUrl !== undefined && repair.sourceUrl !== before.sourceUrl) {
    changed.push('sourceUrl')
  }
  return changed
}

export type ContentHumanReviewResult = {
  entityType: ContentHumanReviewEntityType
  entityId: string
  conclusion: 'CONFIRMED_CURRENT'
  reviewedAt: Date
  updatedAt: Date
  repairedFields: string[]
}

export async function confirmContentCurrentAction(input: {
  db?: ContentHumanReviewClient
  tenantId: string
  venueId: string
  entityType: ContentHumanReviewEntityType
  entityId: string
  expectedUpdatedAt: Date
  conclusion: 'CONFIRMED_CURRENT'
  explicitlyConfirmedCurrent: true
  provenanceRepair?: ContentHumanReviewProvenanceRepair | undefined
  actor: ContentHumanReviewActor
  now?: Date
}): Promise<ContentHumanReviewResult> {
  assertActor(input.actor)
  if (!input.tenantId || !input.venueId || !input.entityId)
    invalid('Exact content scope is required.')
  if (input.conclusion !== 'CONFIRMED_CURRENT' || input.explicitlyConfirmedCurrent !== true) {
    invalid('Current factual content must be explicitly confirmed.')
  }
  if (Number.isNaN(input.expectedUpdatedAt.getTime())) invalid('The expected revision is invalid.')
  const repair = validateRepair(input.provenanceRepair)

  return (input.db ?? db).$transaction(async (tx) => {
    const where = {
      id: input.entityId,
      tenantId: input.tenantId,
      venueId: input.venueId,
    }
    const before =
      input.entityType === 'PLACE'
        ? await tx.place.findFirst({
            where: { ...where, isActive: true },
            select: {
              id: true,
              updatedAt: true,
              lastReviewedAt: true,
              lastReviewedBy: true,
              humanConfirmedAt: true,
              humanConfirmedBy: true,
              sourceType: true,
              sourceName: true,
              sourceUrl: true,
            },
          })
        : await tx.venueKnowledgeEntry.findFirst({
            where: { ...where, isEnabled: true },
            select: {
              id: true,
              updatedAt: true,
              lastReviewedAt: true,
              lastReviewedBy: true,
              humanConfirmedAt: true,
              humanConfirmedBy: true,
              sourceType: true,
              sourceName: true,
              sourceUrl: true,
            },
          })
    if (!before) throw new ContentHumanReviewError('NOT_FOUND', 'Active content was not found.')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new ContentHumanReviewError('CONFLICT', 'Content changed; refresh before reviewing.')
    }

    const reviewedAt = input.now ?? new Date()
    const updatedAt = new Date(Math.max(reviewedAt.getTime(), before.updatedAt.getTime() + 1))
    const data = {
      lastReviewedAt: reviewedAt,
      lastReviewedBy: input.actor.id,
      humanConfirmedAt: reviewedAt,
      humanConfirmedBy: input.actor.id,
      updatedAt,
      ...(repair?.sourceType !== undefined ? { sourceType: repair.sourceType } : {}),
      ...(repair?.sourceName !== undefined ? { sourceName: repair.sourceName } : {}),
      ...(repair?.sourceUrl !== undefined ? { sourceUrl: repair.sourceUrl } : {}),
    }
    const result =
      input.entityType === 'PLACE'
        ? await tx.place.updateMany({
            where: { ...where, isActive: true, updatedAt: input.expectedUpdatedAt },
            data,
          })
        : await tx.venueKnowledgeEntry.updateMany({
            where: { ...where, isEnabled: true, updatedAt: input.expectedUpdatedAt },
            data,
          })
    if (result.count !== 1) {
      throw new ContentHumanReviewError('CONFLICT', 'Content changed; refresh before reviewing.')
    }

    const repairedFields = changedProvenanceFields(before, repair)
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'content.human_review.confirmed_current',
        targetType: input.entityType === 'PLACE' ? 'Place' : 'VenueKnowledgeEntry',
        targetId: input.entityId,
        beforeState: {
          venueId: input.venueId,
          entityType: input.entityType,
          hadPriorReview: before.lastReviewedAt !== null,
          hadPriorHumanConfirmation: before.humanConfirmedAt !== null,
          sourceType: before.sourceType,
          hadSourceName: before.sourceName !== null,
          hadSourceUrl: before.sourceUrl !== null,
        },
        afterState: {
          venueId: input.venueId,
          entityType: input.entityType,
          conclusion: input.conclusion,
          reviewedAt: reviewedAt.toISOString(),
          humanConfirmed: true,
          repairedFields,
        },
      },
      tx,
    )

    return {
      entityType: input.entityType,
      entityId: input.entityId,
      conclusion: input.conclusion,
      reviewedAt,
      updatedAt,
      repairedFields,
    }
  })
}

import { createHash } from 'node:crypto'

import { parseVerifiedActorContext } from '@pathfinder/contracts/actor'
import type { VerifiedActorContext } from '@pathfinder/contracts/actor'
import type {
  CompanyKnowledgeAccessScope,
  CompanyKnowledgeAuthority,
  CompanyKnowledgeSourceType,
  CompanyKnowledgeType,
  Prisma,
} from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type CompanyKnowledgeActionClient = Pick<typeof db, '$transaction'>

export class CompanyKnowledgeActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID_SCOPE',
    message: string,
  ) {
    super(message)
    this.name = 'CompanyKnowledgeActionError'
  }
}

function digest(...parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function requireCapability(actor: VerifiedActorContext, expected: string) {
  if (actor.type === 'AGENT' && actor.capability !== expected) {
    throw new CompanyKnowledgeActionError('FORBIDDEN', `Machine actor requires ${expected}`)
  }
}

async function verifyScope(
  tx: typeof db,
  input: {
    tenantId?: string
    venueId?: string
    organizationId?: string
    accessScope: CompanyKnowledgeAccessScope
  },
) {
  if (input.venueId && !input.tenantId) {
    throw new CompanyKnowledgeActionError('INVALID_SCOPE', 'Venue knowledge requires tenant scope')
  }
  if (input.accessScope === 'TENANT' && !input.tenantId) {
    throw new CompanyKnowledgeActionError('INVALID_SCOPE', 'Tenant knowledge requires tenantId')
  }
  if (input.accessScope === 'VENUE' && (!input.tenantId || !input.venueId)) {
    throw new CompanyKnowledgeActionError(
      'INVALID_SCOPE',
      'Venue knowledge requires tenantId and venueId',
    )
  }
  if (input.accessScope === 'ORGANIZATION' && !input.organizationId) {
    throw new CompanyKnowledgeActionError(
      'INVALID_SCOPE',
      'Organization knowledge requires organizationId',
    )
  }
  if (input.venueId && input.tenantId) {
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue)
      throw new CompanyKnowledgeActionError('NOT_FOUND', 'Venue not found in tenant scope')
  }
  if (input.organizationId) {
    const organization = await tx.prospectOrganization.findFirst({
      where: {
        id: input.organizationId,
        archivedAt: null,
        ...(input.tenantId
          ? { customerRelationships: { some: { tenantId: input.tenantId, status: 'ACTIVE' } } }
          : {}),
      },
      select: { id: true },
    })
    if (!organization) {
      throw new CompanyKnowledgeActionError('NOT_FOUND', 'Organization not found in verified scope')
    }
  }
}

export async function createCompanyKnowledgeCandidateAction(
  input: {
    tenantId?: string
    venueId?: string
    organizationId?: string
    type: CompanyKnowledgeType
    title: string
    summary: string
    body: string
    structuredData?: Prisma.InputJsonValue
    accessScope: CompanyKnowledgeAccessScope
    allowedRoles?: string[]
    authority: CompanyKnowledgeAuthority
    confidence?: number
    effectiveAt?: Date
    sourceType: CompanyKnowledgeSourceType
    sourceId?: string
    sourceRef?: string
    sourceExcerpt?: string
    idempotencyKey: string
    actor: VerifiedActorContext
  },
  client: CompanyKnowledgeActionClient = db,
) {
  const actor = parseVerifiedActorContext(input.actor)
  requireCapability(actor, 'knowledge.propose')
  if (actor.type === 'AGENT' && input.authority === 'AUTHORITATIVE_CURRENT') {
    throw new CompanyKnowledgeActionError(
      'FORBIDDEN',
      'Machine proposals cannot claim authoritative-current status',
    )
  }
  if (!input.title.trim() || !input.summary.trim() || !input.body.trim()) {
    throw new CompanyKnowledgeActionError('CONFLICT', 'Knowledge content must be non-empty')
  }
  const contentHash = digest(input.title.trim(), input.summary.trim(), input.body.trim())
  const sourceDigest = digest(input.body.trim(), input.structuredData ?? {})
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const existing = await tx.companyKnowledgeItem.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, contentHash: true, promotionStatus: true },
    })
    if (existing) {
      if (existing.contentHash !== contentHash) {
        throw new CompanyKnowledgeActionError('CONFLICT', 'Idempotency key reused with new content')
      }
      return { ...existing, replayed: true }
    }
    await verifyScope(tx, input)
    const item = await tx.companyKnowledgeItem.create({
      data: {
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        ...(input.venueId ? { venueId: input.venueId } : {}),
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        type: input.type,
        title: input.title.trim(),
        summary: input.summary.trim(),
        accessScope: input.accessScope,
        allowedRoles: input.allowedRoles ?? [],
        authority: input.authority,
        promotionStatus: 'CANDIDATE',
        contentHash,
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.effectiveAt ? { effectiveAt: input.effectiveAt } : {}),
        createdByType: actor.type,
        createdById: actor.actorId,
        ...(actor.modelProvider ? { modelProvider: actor.modelProvider } : {}),
        ...(actor.modelName ? { modelName: actor.modelName } : {}),
        idempotencyKey: input.idempotencyKey,
        revisions: {
          create: {
            ...(input.tenantId ? { tenantId: input.tenantId } : {}),
            revision: 1,
            body: input.body.trim(),
            structuredData: input.structuredData ?? {},
            sourceDigest,
            authoredByType: actor.type,
            authoredById: actor.actorId,
            ...(actor.modelProvider ? { modelProvider: actor.modelProvider } : {}),
            ...(actor.modelName ? { modelName: actor.modelName } : {}),
          },
        },
        sources: {
          create: {
            ...(input.tenantId ? { tenantId: input.tenantId } : {}),
            sourceType: input.sourceType,
            ...(input.sourceId ? { sourceId: input.sourceId } : {}),
            ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
            ...(input.sourceExcerpt ? { excerpt: input.sourceExcerpt } : {}),
            ...(input.effectiveAt ? { occurredAt: input.effectiveAt } : {}),
          },
        },
      },
      select: { id: true, contentHash: true, promotionStatus: true },
    })
    await writeAuditLogStrict(
      {
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        actor,
        action: 'company-knowledge.candidate-created',
        targetType: 'CompanyKnowledgeItem',
        targetId: item.id,
        idempotencyKey: input.idempotencyKey,
        structuredReason: { type: input.type, authority: input.authority },
        sourceReferences: [{ type: input.sourceType, id: input.sourceId, ref: input.sourceRef }],
        afterState: { promotionStatus: item.promotionStatus, contentHash },
      },
      tx,
    )
    return { ...item, replayed: false }
  })
}

export async function promoteCompanyKnowledgeAction(
  input: {
    knowledgeItemId: string
    tenantId?: string
    promotionReason: string
    actor: VerifiedActorContext
  },
  client: CompanyKnowledgeActionClient = db,
) {
  const actor = parseVerifiedActorContext(input.actor)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const item = await tx.companyKnowledgeItem.findFirst({
      where: {
        id: input.knowledgeItemId,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        archivedAt: null,
      },
      select: {
        id: true,
        promotionStatus: true,
        authority: true,
        tenantId: true,
        venueId: true,
      },
    })
    if (!item) throw new CompanyKnowledgeActionError('NOT_FOUND', 'Knowledge candidate not found')
    if (item.promotionStatus === 'PROMOTED') return { ...item, replayed: true }
    if (item.promotionStatus !== 'CANDIDATE') {
      throw new CompanyKnowledgeActionError('CONFLICT', 'Only candidates may be promoted')
    }
    if (actor.type === 'AGENT') {
      requireCapability(actor, 'knowledge.promote-low-risk')
      if (!['DURABLE_CONTEXT', 'INFERENCE'].includes(item.authority)) {
        throw new CompanyKnowledgeActionError(
          'FORBIDDEN',
          'Machine promotion is limited to low-risk context and inference',
        )
      }
    }
    if (item.authority === 'AUTHORITATIVE_CURRENT' && actor.type !== 'HUMAN') {
      throw new CompanyKnowledgeActionError(
        'FORBIDDEN',
        'Authoritative knowledge requires human promotion',
      )
    }
    const promoted = await tx.companyKnowledgeItem.update({
      where: { id: item.id },
      data: { promotionStatus: 'PROMOTED', lastConfirmedAt: new Date() },
      select: {
        id: true,
        promotionStatus: true,
        authority: true,
        tenantId: true,
        venueId: true,
        updatedAt: true,
      },
    })
    if (promoted.tenantId && promoted.venueId) {
      await tx.embeddingDispatch.upsert({
        where: {
          tenantId_venueId_entityType_entityId: {
            tenantId: promoted.tenantId,
            venueId: promoted.venueId,
            entityType: 'COMPANY_KNOWLEDGE',
            entityId: promoted.id,
          },
        },
        create: {
          id: `company-knowledge:${promoted.id}`,
          tenantId: promoted.tenantId,
          venueId: promoted.venueId,
          entityType: 'COMPANY_KNOWLEDGE',
          entityId: promoted.id,
          contentUpdatedAt: promoted.updatedAt,
        },
        update: {
          contentUpdatedAt: promoted.updatedAt,
          attempts: 0,
          nextAttemptAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      })
    }
    await writeAuditLogStrict(
      {
        tenantId: item.tenantId,
        actor,
        action: 'company-knowledge.promoted',
        targetType: 'CompanyKnowledgeItem',
        targetId: item.id,
        structuredReason: { promotionReason: input.promotionReason },
        beforeState: { promotionStatus: item.promotionStatus },
        afterState: { promotionStatus: promoted.promotionStatus },
      },
      tx,
    )
    return { ...promoted, replayed: false }
  })
}

export async function supersedeCompanyKnowledgeAction(
  input: {
    priorItemId: string
    replacementItemId: string
    tenantId?: string
    reason: string
    actor: VerifiedActorContext
  },
  client: CompanyKnowledgeActionClient = db,
) {
  const actor = parseVerifiedActorContext(input.actor)
  if (actor.type !== 'HUMAN') {
    throw new CompanyKnowledgeActionError('FORBIDDEN', 'Supersession requires a human actor')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const select = {
      id: true,
      tenantId: true,
      promotionStatus: true,
      authority: true,
      supersededById: true,
    } as const
    const [prior, replacement] = await Promise.all([
      tx.companyKnowledgeItem.findFirst({
        where: {
          id: input.priorItemId,
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          archivedAt: null,
        },
        select,
      }),
      tx.companyKnowledgeItem.findFirst({
        where: {
          id: input.replacementItemId,
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          archivedAt: null,
        },
        select,
      }),
    ])
    if (!prior || !replacement) {
      throw new CompanyKnowledgeActionError('NOT_FOUND', 'Prior or replacement knowledge not found')
    }
    if (prior.id === replacement.id || replacement.promotionStatus !== 'PROMOTED') {
      throw new CompanyKnowledgeActionError(
        'CONFLICT',
        'Replacement must be a different promoted item',
      )
    }
    if (prior.supersededById === replacement.id) return { prior, replacement, replayed: true }
    if (prior.supersededById) {
      throw new CompanyKnowledgeActionError('CONFLICT', 'Prior item is already superseded')
    }
    const updated = await tx.companyKnowledgeItem.update({
      where: { id: prior.id },
      data: {
        authority: 'SUPERSEDED',
        promotionStatus: 'SUPERSEDED',
        supersededAt: new Date(),
        supersededById: replacement.id,
        ...(prior.authority === 'AUTHORITATIVE_CURRENT'
          ? { decision: { update: { status: 'SUPERSEDED' } } }
          : {}),
      },
      select: { id: true, supersededById: true, authority: true, promotionStatus: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: prior.tenantId,
        actor,
        action: 'company-knowledge.superseded',
        targetType: 'CompanyKnowledgeItem',
        targetId: prior.id,
        structuredReason: { reason: input.reason, replacementItemId: replacement.id },
        beforeState: { authority: prior.authority, promotionStatus: prior.promotionStatus },
        afterState: { ...updated },
      },
      tx,
    )
    return { prior: updated, replacement, replayed: false }
  })
}

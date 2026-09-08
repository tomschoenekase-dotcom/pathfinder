import { z } from 'zod'

import { db } from '../client'

type Transaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]
export type ConversationLearningPolicy = 'VISITOR_AND_EMPLOYEE' | 'EMPLOYEE_ONLY' | 'DISABLED'
export type ConversationLearningCandidate = {
  id: string
  sessionId: string
  summary: string
  evidenceMessageIds: unknown
  candidateProvenance: unknown
  candidateRevision: number
  reviewerFeedback: string | null
  reviewStatus: 'UNREVIEWED' | 'ACKNOWLEDGED' | 'DISMISSED'
  reviewedBy: string | null
  reviewedAt: Date | null
  createdAt: Date
}
export type ConversationLearningReviewResult = {
  insight: {
    id: string
    candidateRevision: number
    reviewStatus: string
    evidenceMessageIds?: unknown
  }
  replayed: boolean
}
type LearningPolicy = ConversationLearningPolicy
type Reviewer =
  | { type: 'HUMAN'; id: string; role: 'OWNER' | 'MANAGER' }
  | { type: 'PLATFORM_ADMIN'; id: string }

const policySchema = z.enum(['VISITOR_AND_EMPLOYEE', 'EMPLOYEE_ONLY', 'DISABLED'])
const scopeSchema = z
  .object({ tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) })
  .strict()
const reviewerSchema = z.union([
  z
    .object({
      type: z.literal('HUMAN'),
      id: z.string().min(1).max(191),
      role: z.enum(['OWNER', 'MANAGER']),
    })
    .strict(),
  z.object({ type: z.literal('PLATFORM_ADMIN'), id: z.string().min(1).max(191) }).strict(),
])
const provenanceSchema = z
  .object({
    source: z.enum(['PUBLIC', 'SECOND_LAYER']),
    authenticatedActorRef: z.string().min(1).max(191).optional(),
    policySnapshot: policySchema,
    classifier: z
      .object({ kind: z.string().min(1).max(64), version: z.string().min(1).max(64) })
      .strict(),
    verification: z.literal('UNVERIFIED'),
    hedged: z.boolean(),
  })
  .strict()

export class ConversationLearningActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ConversationLearningActionError'
  }
}

async function requireReviewer(
  tx: Transaction,
  scope: z.infer<typeof scopeSchema>,
  actor: Reviewer,
) {
  if (actor.type === 'PLATFORM_ADMIN') return
  const membership = await tx.tenantMembership.findFirst({
    where: { tenantId: scope.tenantId, userId: actor.id, status: 'ACTIVE', role: actor.role },
    select: { id: true },
  })
  if (!membership)
    throw new ConversationLearningActionError(
      'FORBIDDEN',
      'An active owner or manager membership is required.',
    )
}

async function lockLearningScope(tx: Transaction, scope: { tenantId: string; venueId: string }) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conversation-learning:${scope.tenantId}:${scope.venueId}`}, 0))`
}

function auditData(input: {
  id: string
  scope: z.infer<typeof scopeSchema>
  actor: Reviewer
  action: string
  targetId: string
  beforeState?: Record<string, unknown>
  afterState?: Record<string, unknown>
  structuredReason?: Record<string, unknown>
}) {
  return {
    id: input.id,
    tenantId: input.scope.tenantId,
    actorType: 'HUMAN' as const,
    actorId: input.actor.id,
    actorRole: input.actor.type === 'PLATFORM_ADMIN' ? 'PLATFORM_ADMIN' : input.actor.role,
    action: input.action,
    targetType: 'conversation-learning-candidate',
    targetId: input.targetId,
    ...(input.beforeState ? { beforeState: input.beforeState } : {}),
    ...(input.afterState ? { afterState: input.afterState } : {}),
    ...(input.structuredReason ? { structuredReason: input.structuredReason } : {}),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export async function getConversationLearningPolicy(
  raw: z.input<typeof scopeSchema>,
  client: Pick<typeof db, 'venue'> = db,
) {
  const scope = scopeSchema.parse(raw)
  const venue = await client.venue.findFirst({
    where: { id: scope.venueId, tenantId: scope.tenantId },
    select: { conversationLearningPolicy: true, updatedAt: true },
  })
  if (!venue) throw new ConversationLearningActionError('NOT_FOUND', 'Venue not found.')
  return { policy: venue.conversationLearningPolicy as LearningPolicy, updatedAt: venue.updatedAt }
}

export async function updateConversationLearningPolicy(
  raw: {
    tenantId: string
    venueId: string
    policy: LearningPolicy
    expectedUpdatedAt: Date
    actor: Reviewer
    operationId: string
  },
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsed = z
    .object({
      ...scopeSchema.shape,
      policy: policySchema,
      expectedUpdatedAt: z.date(),
      actor: reviewerSchema,
      operationId: z.string().uuid(),
    })
    .strict()
    .parse(raw)
  return client.$transaction(async (tx) => {
    const scope = { tenantId: parsed.tenantId, venueId: parsed.venueId }
    await lockLearningScope(tx, scope)
    await requireReviewer(tx, scope, parsed.actor)
    const identity = {
      actor: parsed.actor,
      expectedUpdatedAt: parsed.expectedUpdatedAt.toISOString(),
      policy: parsed.policy,
      venueId: scope.venueId,
    }
    const replay = await tx.auditLog.findFirst({
      where: { id: parsed.operationId, tenantId: scope.tenantId },
      select: { action: true, targetId: true, structuredReason: true, afterState: true },
    })
    if (replay) {
      if (
        replay.action !== 'conversation-learning.policy.updated' ||
        replay.targetId !== scope.venueId ||
        canonical(replay.structuredReason) !== canonical(identity)
      )
        throw new ConversationLearningActionError(
          'CONFLICT',
          'Policy operation ID was already used for different content.',
        )
      const state = replay.afterState as { policy?: LearningPolicy; updatedAt?: string } | null
      if (!state?.policy || !state.updatedAt)
        throw new ConversationLearningActionError(
          'CONFLICT',
          'Policy operation replay is incomplete.',
        )
      return { policy: state.policy, updatedAt: new Date(state.updatedAt) }
    }
    const existing = await tx.venue.findFirst({
      where: { id: scope.venueId, tenantId: scope.tenantId },
      select: { conversationLearningPolicy: true, updatedAt: true },
    })
    if (!existing) throw new ConversationLearningActionError('NOT_FOUND', 'Venue not found.')
    if (existing.updatedAt.getTime() !== parsed.expectedUpdatedAt.getTime())
      throw new ConversationLearningActionError(
        'CONFLICT',
        'Learning policy changed; refresh before retrying.',
      )
    const nextUpdatedAt = new Date(Math.max(Date.now(), parsed.expectedUpdatedAt.getTime() + 1))
    const updated = await tx.venue.updateMany({
      where: { id: scope.venueId, tenantId: scope.tenantId, updatedAt: parsed.expectedUpdatedAt },
      data: { conversationLearningPolicy: parsed.policy, updatedAt: nextUpdatedAt },
    })
    if (updated.count !== 1)
      throw new ConversationLearningActionError(
        'CONFLICT',
        'Learning policy changed; refresh before retrying.',
      )
    const readback = await tx.venue.findFirst({
      where: { id: scope.venueId, tenantId: scope.tenantId },
      select: { conversationLearningPolicy: true, updatedAt: true },
    })
    if (!readback) throw new ConversationLearningActionError('NOT_FOUND', 'Venue not found.')
    await tx.auditLog.create({
      data: auditData({
        id: parsed.operationId,
        scope,
        actor: parsed.actor,
        action: 'conversation-learning.policy.updated',
        targetId: scope.venueId,
        beforeState: {
          policy: existing.conversationLearningPolicy,
          updatedAt: existing.updatedAt.toISOString(),
        },
        afterState: {
          policy: readback.conversationLearningPolicy,
          updatedAt: readback.updatedAt.toISOString(),
        },
        structuredReason: identity,
      }),
    })
    return {
      policy: readback.conversationLearningPolicy as LearningPolicy,
      updatedAt: readback.updatedAt,
    }
  })
}

export async function recordConversationLearningCandidate(
  raw: {
    tenantId: string
    venueId: string
    sessionId: string
    guestChatTurnId: string
    userMessageId: string
    source: 'PUBLIC' | 'SECOND_LAYER'
    authenticatedActorRef?: string
    summary: string
    classifier: { kind: string; version: string }
    hedged: boolean
  },
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsed = z
    .object({
      ...scopeSchema.shape,
      sessionId: z.string().min(1).max(191),
      guestChatTurnId: z.string().uuid(),
      userMessageId: z.string().min(1).max(191),
      source: z.enum(['PUBLIC', 'SECOND_LAYER']),
      authenticatedActorRef: z.string().min(1).max(191).optional(),
      summary: z.string().trim().min(1).max(1000),
      classifier: provenanceSchema.shape.classifier,
      hedged: z.boolean(),
    })
    .strict()
    .parse(raw)
  return client.$transaction(async (tx) => {
    const scope = { tenantId: parsed.tenantId, venueId: parsed.venueId }
    await lockLearningScope(tx, scope)
    const venue = await tx.venue.findFirst({
      where: { id: scope.venueId, tenantId: scope.tenantId },
      select: { conversationLearningPolicy: true },
    })
    if (!venue) throw new ConversationLearningActionError('NOT_FOUND', 'Venue not found.')
    const employee = parsed.source === 'SECOND_LAYER'
    if (
      venue.conversationLearningPolicy === 'DISABLED' ||
      (venue.conversationLearningPolicy === 'EMPLOYEE_ONLY' && !employee)
    )
      throw new ConversationLearningActionError(
        'FORBIDDEN',
        'Conversation learning is not eligible for this source.',
      )
    if (employee) {
      if (!parsed.authenticatedActorRef)
        throw new ConversationLearningActionError(
          'FORBIDDEN',
          'Employee learning requires an established actor.',
        )
      const membership = await tx.tenantMembership.findFirst({
        where: { tenantId: scope.tenantId, userId: parsed.authenticatedActorRef, status: 'ACTIVE' },
        select: { id: true },
      })
      if (!membership)
        throw new ConversationLearningActionError(
          'FORBIDDEN',
          'Employee learning requires an active membership.',
        )
    }
    const turn = await tx.guestChatTurn.findFirst({
      where: {
        id: parsed.guestChatTurnId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        sessionId: parsed.sessionId,
        userMessageId: parsed.userMessageId,
        session: { experienceScope: parsed.source },
        userMessage: { is: { id: parsed.userMessageId, role: 'user' } },
      },
      select: { id: true },
    })
    if (!turn)
      throw new ConversationLearningActionError(
        'NOT_FOUND',
        'Source turn does not match the requested tenant, venue, session, and scope.',
      )
    const provenance = provenanceSchema.parse({
      source: parsed.source,
      ...(employee ? { authenticatedActorRef: parsed.authenticatedActorRef } : {}),
      policySnapshot: venue.conversationLearningPolicy,
      classifier: parsed.classifier,
      verification: 'UNVERIFIED',
      hedged: parsed.hedged,
    })
    const created = await tx.conversationInsight.createMany({
      data: [
        {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          sessionId: parsed.sessionId,
          guestChatTurnId: parsed.guestChatTurnId,
          category: 'CONTENT_UPDATE_CANDIDATE',
          confidence: 0,
          severity: 'INFO',
          summary: parsed.summary,
          evidenceMessageIds: [parsed.userMessageId],
          capability: 'conversation-learning',
          provider: 'pathfinder',
          model: 'rules',
          analyzerVersion: parsed.classifier.version,
          candidateProvenance: provenance,
        },
      ],
      skipDuplicates: true,
    })
    const insight = await tx.conversationInsight.findFirst({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        guestChatTurnId: parsed.guestChatTurnId,
        category: 'CONTENT_UPDATE_CANDIDATE',
        analyzerVersion: parsed.classifier.version,
      },
      select: { id: true, candidateRevision: true, reviewStatus: true, candidateProvenance: true },
    })
    if (!insight)
      throw new ConversationLearningActionError('NOT_FOUND', 'Candidate was not persisted.')
    if (created.count === 0) {
      const existingProvenance = provenanceSchema.safeParse(insight.candidateProvenance)
      if (
        !existingProvenance.success ||
        canonical(existingProvenance.data) !== canonical(provenance)
      )
        throw new ConversationLearningActionError(
          'CONFLICT',
          'Candidate key was already used for different provenance.',
        )
    }
    return { insight, replayed: created.count === 0 }
  })
}

export async function listConversationLearningCandidates(
  raw: {
    tenantId: string
    venueId: string
    reviewStatus?: 'UNREVIEWED' | 'ACKNOWLEDGED' | 'DISMISSED'
    limit?: number
  },
  client: Pick<typeof db, 'conversationInsight'> = db,
) {
  const parsed = z
    .object({
      ...scopeSchema.shape,
      reviewStatus: z.enum(['UNREVIEWED', 'ACKNOWLEDGED', 'DISMISSED']).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    })
    .strict()
    .parse(raw)
  return client.conversationInsight.findMany({
    where: {
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      category: 'CONTENT_UPDATE_CANDIDATE',
      candidateProvenance: { path: ['verification'], equals: 'UNVERIFIED' },
      ...(parsed.reviewStatus ? { reviewStatus: parsed.reviewStatus } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: parsed.limit,
    select: {
      id: true,
      sessionId: true,
      summary: true,
      evidenceMessageIds: true,
      candidateProvenance: true,
      candidateRevision: true,
      reviewerFeedback: true,
      reviewStatus: true,
      reviewedBy: true,
      reviewedAt: true,
      createdAt: true,
    },
  })
}

export async function reviewConversationLearningCandidate(
  raw: {
    operationId: string
    tenantId: string
    venueId: string
    insightId: string
    expectedRevision: number
    action: 'EDIT' | 'ACCEPT_FOR_PROPOSAL' | 'REJECT'
    summary?: string
    reviewerFeedback?: string
    actor: Reviewer
  },
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsed = z
    .object({
      operationId: z.string().uuid(),
      ...scopeSchema.shape,
      insightId: z.string().uuid(),
      expectedRevision: z.number().int().min(0),
      action: z.enum(['EDIT', 'ACCEPT_FOR_PROPOSAL', 'REJECT']),
      summary: z.string().trim().min(1).max(1000).optional(),
      reviewerFeedback: z.string().trim().min(1).max(1000).optional(),
      actor: reviewerSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === 'EDIT' && !value.summary)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['summary'],
          message: 'An edit needs a summary.',
        })
      if (value.action !== 'EDIT' && !value.reviewerFeedback)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reviewerFeedback'],
          message: 'A review decision needs feedback.',
        })
    })
    .parse(raw)
  return client.$transaction(async (tx) => {
    const scope = { tenantId: parsed.tenantId, venueId: parsed.venueId }
    await lockLearningScope(tx, scope)
    await requireReviewer(tx, scope, parsed.actor)
    const replay = await tx.auditLog.findFirst({
      where: { id: parsed.operationId, tenantId: scope.tenantId },
      select: { action: true, targetId: true, structuredReason: true, afterState: true },
    })
    const identity = {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      actor: parsed.actor,
      insightId: parsed.insightId,
      expectedRevision: parsed.expectedRevision,
      action: parsed.action,
      summary: parsed.summary ?? null,
      reviewerFeedback: parsed.reviewerFeedback ?? null,
    }
    if (replay) {
      if (
        replay.action !== 'conversation-learning.candidate.reviewed' ||
        replay.targetId !== parsed.insightId ||
        canonical(replay.structuredReason) !== canonical(identity)
      )
        throw new ConversationLearningActionError(
          'CONFLICT',
          'Review operation ID was already used for different content.',
        )
      const row = await tx.conversationInsight.findFirst({
        where: { id: parsed.insightId, tenantId: scope.tenantId, venueId: scope.venueId },
        select: { id: true, candidateRevision: true, reviewStatus: true },
      })
      if (!row) throw new ConversationLearningActionError('NOT_FOUND', 'Candidate not found.')
      const result = z
        .object({ revision: z.number().int().nonnegative(), status: z.string() })
        .parse(replay.afterState)
      return {
        insight: { id: row.id, candidateRevision: result.revision, reviewStatus: result.status },
        replayed: true as const,
        canonicalKnowledgeChanged: false as const,
      }
    }
    const existing = await tx.conversationInsight.findFirst({
      where: {
        id: parsed.insightId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        category: 'CONTENT_UPDATE_CANDIDATE',
        candidateProvenance: { path: ['verification'], equals: 'UNVERIFIED' },
      },
      select: { id: true, candidateRevision: true, summary: true, reviewStatus: true },
    })
    if (!existing) throw new ConversationLearningActionError('NOT_FOUND', 'Candidate not found.')
    if (existing.reviewStatus === 'ACTIONED' || existing.reviewStatus === 'DISMISSED')
      throw new ConversationLearningActionError('CONFLICT', 'Candidate is already terminal.')
    if (existing.candidateRevision !== parsed.expectedRevision)
      throw new ConversationLearningActionError(
        'CONFLICT',
        'Candidate changed; refresh before reviewing.',
      )
    const status =
      parsed.action === 'ACCEPT_FOR_PROPOSAL'
        ? 'ACKNOWLEDGED'
        : parsed.action === 'REJECT'
          ? 'DISMISSED'
          : existing.reviewStatus
    const updated = await tx.conversationInsight.updateMany({
      where: {
        id: existing.id,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        candidateRevision: parsed.expectedRevision,
        reviewStatus: existing.reviewStatus,
      },
      data: {
        ...(parsed.summary ? { summary: parsed.summary } : {}),
        ...(parsed.reviewerFeedback ? { reviewerFeedback: parsed.reviewerFeedback } : {}),
        reviewStatus: status,
        reviewedBy: status === 'UNREVIEWED' ? null : parsed.actor.id,
        reviewedAt: status === 'UNREVIEWED' ? null : new Date(),
        candidateRevision: { increment: 1 },
      },
    })
    if (updated.count !== 1)
      throw new ConversationLearningActionError(
        'CONFLICT',
        'Candidate changed; refresh before reviewing.',
      )
    const insight = await tx.conversationInsight.findFirst({
      where: { id: existing.id, tenantId: scope.tenantId, venueId: scope.venueId },
      select: { id: true, candidateRevision: true, reviewStatus: true, evidenceMessageIds: true },
    })
    if (!insight) throw new ConversationLearningActionError('NOT_FOUND', 'Candidate not found.')
    await tx.auditLog.create({
      data: {
        ...auditData({
          id: parsed.operationId,
          scope,
          actor: parsed.actor,
          action: 'conversation-learning.candidate.reviewed',
          targetId: existing.id,
          beforeState: { revision: existing.candidateRevision, status: existing.reviewStatus },
          afterState: { revision: insight.candidateRevision, status: insight.reviewStatus },
        }),
        structuredReason: identity,
      },
    })
    return { insight, replayed: false as const, canonicalKnowledgeChanged: false as const }
  })
}

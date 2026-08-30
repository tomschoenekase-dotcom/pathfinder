import { createHash } from 'node:crypto'

import {
  FIRST_WEEK_ACCOUNT_REVIEW_VERSION,
  FirstWeekAccountReviewMetrics,
  FirstWeekAccountReviewSnapshot,
  type FirstWeekReviewMilestone,
} from '@pathfinder/contracts'
import { canonicalEvaluationJson, type CanonicalJsonValue } from '@pathfinder/contracts/evaluation'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { publishOperationalEvent } from './operational-events'

const DAY_MS = 86_400_000
const MILESTONES = [
  { milestone: 'DAY_1', days: 1 },
  { milestone: 'DAY_3', days: 3 },
  { milestone: 'DAY_7', days: 7 },
] as const satisfies ReadonlyArray<{ milestone: FirstWeekReviewMilestone; days: number }>

type MaterializeClient = Pick<typeof db, '$transaction'>
type FirstWeekReviewTransaction = Pick<
  typeof db,
  | 'venue'
  | 'firstWeekAccountReview'
  | 'onboardingMilestoneEvent'
  | 'visitorSession'
  | 'message'
  | 'conversationInsight'
  | 'messageFeedback'
  | 'supportRequestAuditEvent'
  | 'aiUsageEvent'
  | 'operationalEvent'
  | 'auditLog'
>

export type MaterializeFirstWeekAccountReviewsInput = {
  tenantId: string
  venueId: string
  now: Date
  systemJobId?: string
}

export class FirstWeekAccountReviewError extends Error {
  constructor(
    readonly code: 'INVALID_SCOPE' | 'SNAPSHOT_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'FirstWeekAccountReviewError'
  }
}

function normalizeUsd(value: unknown): string {
  const raw = String(value ?? '0')
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) return '0'
  const [integer = '0', rawFraction = ''] = raw.split('.')
  const fraction = rawFraction.slice(0, 8).replace(/0+$/u, '')
  return fraction ? `${integer}.${fraction}` : integer
}

function buildDraft(params: {
  milestone: FirstWeekReviewMilestone
  metrics: FirstWeekAccountReviewMetrics
}) {
  const { milestone, metrics } = params
  const actionableSignals =
    metrics.lowConfidenceInsights +
    metrics.knowledgeGapInsights +
    metrics.negativeFeedback +
    metrics.supportRequestsCreated +
    metrics.failedAiRequests
  const shouldDraft = actionableSignals > 0 || (milestone === 'DAY_7' && metrics.publicSessions > 0)
  if (!shouldDraft) {
    return {
      disposition: 'NO_ACTION' as const,
      draftSubject: null,
      draftBody: null,
      draftReason: null,
    }
  }

  const period =
    milestone === 'DAY_1' ? 'first day' : milestone === 'DAY_3' ? 'first few days' : 'first week'
  const signalReason = [
    metrics.lowConfidenceInsights > 0
      ? `${metrics.lowConfidenceInsights} low-confidence signal(s)`
      : null,
    metrics.knowledgeGapInsights > 0
      ? `${metrics.knowledgeGapInsights} knowledge-gap signal(s)`
      : null,
    metrics.negativeFeedback > 0 ? `${metrics.negativeFeedback} negative rating(s)` : null,
    metrics.supportRequestsCreated > 0
      ? `${metrics.supportRequestsCreated} support request(s)`
      : null,
    metrics.failedAiRequests > 0 ? `${metrics.failedAiRequests} failed AI request(s)` : null,
  ].filter((value): value is string => value !== null)

  return {
    disposition: 'DRAFT_READY' as const,
    draftSubject: 'A quick first-week check-in',
    draftBody:
      actionableSignals > 0
        ? `Hi — we’ve been reviewing your ${period} with Torchiko and found a few areas we’re actively checking. We’ll keep improving the experience, and I’d also love to hear how it has felt for your team so far. Is there anything you’d like us to look at first?`
        : `Hi — we’ve been reviewing your ${period} with Torchiko and wanted to check in. How has the experience felt for your team so far? If there is anything you’d like adjusted, just let us know and we’ll take care of it.`,
    draftReason:
      signalReason.length > 0
        ? `Review before sending: ${signalReason.join(', ')}.`
        : `Review before sending: ${metrics.publicSessions} public session(s) recorded during the first week.`,
  }
}

async function collectMetrics(
  transaction: FirstWeekReviewTransaction,
  scope: { tenantId: string; venueId: string; releaseAt: Date; dueAt: Date },
) {
  const window = { gte: scope.releaseAt, lt: scope.dueAt }
  const [
    publicSessions,
    guestQuestions,
    lowConfidenceInsights,
    knowledgeGapInsights,
    negativeFeedback,
    supportRequestsCreated,
    aiUsage,
    failedAiRequests,
  ] = await Promise.all([
    transaction.visitorSession.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        experienceScope: 'PUBLIC',
        startedAt: window,
      },
    }),
    transaction.message.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        role: 'user',
        createdAt: window,
        session: { experienceScope: 'PUBLIC' },
      },
    }),
    transaction.conversationInsight.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        category: 'LOW_CONFIDENCE_ANSWER',
        createdAt: window,
      },
    }),
    transaction.conversationInsight.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        category: { in: ['KNOWLEDGE_GAP', 'UNANSWERED_QUESTION'] },
        createdAt: window,
      },
    }),
    transaction.messageFeedback.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        rating: 'NOT_HELPFUL',
        createdAt: window,
      },
    }),
    transaction.supportRequestAuditEvent.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        eventType: 'REQUEST_CREATED',
        createdAt: window,
      },
    }),
    transaction.aiUsageEvent.aggregate({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        createdAt: window,
      },
      _count: { _all: true },
      _sum: { estimatedCostUsd: true },
    }),
    transaction.aiUsageEvent.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        success: false,
        createdAt: window,
      },
    }),
  ])

  return FirstWeekAccountReviewMetrics.parse({
    publicSessions,
    guestQuestions,
    lowConfidenceInsights,
    knowledgeGapInsights,
    negativeFeedback,
    supportRequestsCreated,
    aiRequests: aiUsage._count._all,
    failedAiRequests,
    estimatedAiCostUsd: normalizeUsd(aiUsage._sum.estimatedCostUsd),
  })
}

function snapshotHash(snapshot: FirstWeekAccountReviewSnapshot): string {
  return createHash('sha256')
    .update(canonicalEvaluationJson(snapshot as CanonicalJsonValue), 'utf8')
    .digest('hex')
}

/**
 * Materializes due day-1/day-3/day-7 reviews from the first release event.
 * It creates aggregate evidence and optional drafts only; it cannot address or send communication.
 */
export async function materializeDueFirstWeekAccountReviews(
  input: MaterializeFirstWeekAccountReviewsInput,
  client: MaterializeClient = db,
) {
  if (!input.tenantId.trim() || !input.venueId.trim() || Number.isNaN(input.now.getTime())) {
    throw new FirstWeekAccountReviewError('INVALID_SCOPE', 'Review scope and time must be valid.')
  }

  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:first-week-review:${input.tenantId}:${input.venueId}`}, 0))`

    const venue = await transaction.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) {
      throw new FirstWeekAccountReviewError(
        'INVALID_SCOPE',
        'The venue does not belong to the supplied tenant.',
      )
    }

    const anchoredReview = await transaction.firstWeekAccountReview.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      orderBy: [{ releaseAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        releaseMilestoneEvent: { select: { id: true, occurredAt: true } },
      },
    })
    const release =
      anchoredReview?.releaseMilestoneEvent ??
      (await transaction.onboardingMilestoneEvent.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          eventType: 'RELEASED',
          occurredAt: { lte: input.now },
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: { id: true, occurredAt: true },
      }))
    if (!release) return []

    const results = []
    for (const definition of MILESTONES) {
      const dueAt = new Date(release.occurredAt.getTime() + definition.days * DAY_MS)
      if (dueAt.getTime() > input.now.getTime()) continue

      const existing = await transaction.firstWeekAccountReview.findUnique({
        where: {
          tenantId_venueId_releaseMilestoneEventId_milestone: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            releaseMilestoneEventId: release.id,
            milestone: definition.milestone,
          },
        },
      })
      if (existing) {
        const parsed = FirstWeekAccountReviewSnapshot.parse({
          version: existing.reviewVersion,
          tenantId: existing.tenantId,
          venueId: existing.venueId,
          releaseMilestoneEventId: existing.releaseMilestoneEventId,
          milestone: existing.milestone,
          releaseAt: existing.releaseAt.toISOString(),
          dueAt: existing.dueAt.toISOString(),
          metrics: existing.metrics,
          disposition: existing.disposition,
          draftSubject: existing.draftSubject,
          draftBody: existing.draftBody,
          draftReason: existing.draftReason,
        })
        if (snapshotHash(parsed) !== existing.snapshotHash) {
          throw new FirstWeekAccountReviewError(
            'SNAPSHOT_CONFLICT',
            'Stored first-week review evidence does not match its immutable hash.',
          )
        }
        results.push({ ...existing, replayed: true as const })
        continue
      }

      const metrics = await collectMetrics(transaction, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        releaseAt: release.occurredAt,
        dueAt,
      })
      const draft = buildDraft({ milestone: definition.milestone, metrics })
      const snapshot = FirstWeekAccountReviewSnapshot.parse({
        version: FIRST_WEEK_ACCOUNT_REVIEW_VERSION,
        tenantId: input.tenantId,
        venueId: input.venueId,
        releaseMilestoneEventId: release.id,
        milestone: definition.milestone,
        releaseAt: release.occurredAt.toISOString(),
        dueAt: dueAt.toISOString(),
        metrics,
        ...draft,
      })
      const digest = snapshotHash(snapshot)
      const created = await transaction.firstWeekAccountReview.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          releaseMilestoneEventId: release.id,
          milestone: definition.milestone,
          reviewVersion: FIRST_WEEK_ACCOUNT_REVIEW_VERSION,
          releaseAt: release.occurredAt,
          dueAt,
          snapshotHash: digest,
          metrics,
          disposition: draft.disposition,
          draftSubject: draft.draftSubject,
          draftBody: draft.draftBody,
          draftReason: draft.draftReason,
        },
      })

      if (created.disposition === 'DRAFT_READY') {
        await publishOperationalEvent({
          client: transaction,
          event: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            eventType: 'customer-learning.first-week-draft-ready',
            sourceSubsystem: 'first-week-account-review',
            severity: 'INFO',
            title: `${definition.milestone.replace('_', ' ').toLowerCase()} customer check-in draft`,
            summary: 'A privacy-bounded first-week review produced a draft for human review.',
            actionRequired: true,
            linkedObjectType: 'FirstWeekAccountReview',
            linkedObjectId: created.id,
            recommendedAction: 'Review the aggregate evidence and edit or discard the draft.',
            deduplicationKey: `first-week-review:${created.id}`,
          },
        })
      }

      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: 'analytics-enrichment',
          actorRole: 'SYSTEM',
          actorType: 'SYSTEM',
          ...(input.systemJobId ? { systemJobId: input.systemJobId } : {}),
          action: 'first-week-account-review.materialized',
          targetType: 'FirstWeekAccountReview',
          targetId: created.id,
          afterState: {
            venueId: input.venueId,
            milestone: definition.milestone,
            releaseMilestoneEventId: release.id,
            dueAt: dueAt.toISOString(),
            snapshotHash: digest,
            disposition: draft.disposition,
            rawConversationContentStored: false,
            recipientStored: false,
            providerSelected: false,
            sendAuthorized: false,
          },
        },
        transaction,
      )
      results.push({ ...created, replayed: false as const })
    }
    return results
  })
}

import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AI_MODEL_KEYS,
  CLIENT_TOCHI_BEHAVIOR_VERSION,
  buildClientTochiSystemBlocks,
  generateText,
  parseClientTochiResponse,
  resolveDeterministicClientTochiResponse,
} from '@pathfinder/ai'
import { emitEvent } from '@pathfinder/analytics'
import { isFeatureEnabled, TOCHI_TENANT_FLAG_KEYS } from '@pathfinder/config'
import { resolveClientPortalLifecycle } from '@pathfinder/contracts/client-portal-lifecycle'
import {
  ClientAssistantActionError,
  assertVenueAiAvailable,
  claimClientAssistantTurnGenerationAction,
  completeClientAssistantTurnAction,
  type ClientAssistantFailureCode,
  createSupportRequestAction,
  linkClientAssistantSupportHandoffAction,
  markClientAssistantTurnProviderDispatchedAction,
  reserveClientAssistantTurnAction,
  setClientAssistantPreferenceAction,
  SupportActionError,
} from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { tenantProcedure } from '../trpc'
import { createApiAiUsageRecorder } from '../lib/api-ai-usage'
import {
  boundedClientAssistantHistory,
  buildClientAssistantContext,
  parseClientTochiQuestion,
  projectClientTochiResponse,
  safeClientTochiFailureReply,
  safeHandoffExcerpt,
  type ClientAssistantClientReply,
} from '../lib/client-assistant-security'

const scopedId = z.string().trim().min(1).max(191)
const supportCategory = z.enum([
  'CONTENT_CORRECTION',
  'OPERATIONAL_UPDATE',
  'BRANDING',
  'EXPERIENCE_BEHAVIOR',
  'ACCESSIBILITY',
  'GENERAL',
])

const replyActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('navigate'),
      href: z.enum(['/', '/information', '/support', '/ai-controls']),
      label: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({
      type: z.literal('preview-support-handoff'),
      category: supportCategory,
      summary: z.string().trim().min(1).max(200),
      requestedOutcome: z.string().trim().min(1).max(1_000),
      relevantFeature: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
])

type TenantContext = TRPCContext & {
  session: TRPCContext['session'] & { userId: string; activeTenantId: string }
}

type PortalTransaction = Parameters<Parameters<TRPCContext['db']['$transaction']>[0]>[0]

function actor(ctx: TenantContext) {
  const role = ctx.session.role
  if (!role) throw new TRPCError({ code: 'FORBIDDEN', message: 'Tenant role is required' })
  return {
    userId: ctx.session.userId,
    auditRole: role,
  }
}

function actionError(error: unknown): never {
  if (error instanceof ClientAssistantActionError || error instanceof SupportActionError) {
    const code =
      error.code === 'INVALID_INPUT'
        ? 'BAD_REQUEST'
        : error.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT'
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

async function clientTochiAvailable(ctx: TenantContext): Promise<boolean> {
  if (!isFeatureEnabled('clientTochi')) return false
  const flag = await ctx.db.tenantFeatureFlag.findUnique({
    where: {
      tenantId_flagKey: {
        tenantId: ctx.session.activeTenantId,
        flagKey: TOCHI_TENANT_FLAG_KEYS.clientTochi,
      },
    },
    select: { enabled: true },
  })
  return flag?.enabled === true
}

async function requireClientTochiAvailable(ctx: TenantContext): Promise<void> {
  if (!(await clientTochiAvailable(ctx)))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Client assistance is not available' })
}

async function requirePreferenceEnabled(ctx: TenantContext): Promise<void> {
  const preference = await ctx.db.clientAssistantPreference.findUnique({
    where: {
      tenantId_userId: {
        tenantId: ctx.session.activeTenantId,
        userId: ctx.session.userId,
      },
    },
    select: { enabled: true },
  })
  if (preference?.enabled === false)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Tochi assistance is turned off' })
}

function statusTotal(
  rows: Array<{ status: string; _count: { _all: number } }>,
  statuses: string[],
) {
  return rows.reduce((sum, row) => sum + (statuses.includes(row.status) ? row._count._all : 0), 0)
}

async function loadContextSource(db: PortalTransaction, tenantId: string, venueId: string) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: {
      id: true,
      name: true,
      isActive: true,
      tonePreset: true,
      venueBotConfiguration: { select: { presentationMode: true } },
      _count: {
        select: {
          places: { where: { isActive: true } },
          knowledgeEntries: { where: { isEnabled: true } },
        },
      },
    },
  })
  if (!venue)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Client assistance is not available' })

  const [
    intakeProposalCount,
    mediaRows,
    packageRows,
    wasLive,
    activeOffboarding,
    uploadCount,
    recentUploads,
    pendingQuestionCount,
  ] = await Promise.all([
    db.intakeRun.count({ where: { tenantId, venueId, status: 'AWAITING_REVIEW' } }),
    db.mediaIngestionProject.groupBy({
      by: ['status'],
      where: { tenantId, venueId },
      _count: { _all: true },
    }),
    db.venuePackage.groupBy({
      by: ['status'],
      where: { tenantId, venueId },
      _count: { _all: true },
    }),
    db.contentVersion.findFirst({
      where: {
        tenantId,
        venueId,
        entityType: 'VENUE',
        afterState: { path: ['isActive'], equals: true },
      },
      select: { id: true },
    }),
    db.offboardingVenueTarget.findFirst({
      where: {
        tenantId,
        venueId,
        plan: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      },
      select: { id: true },
    }),
    db.intakeUpload.count({
      where: { tenantId, venueId, status: { in: ['PRECHECK_PASSED', 'AWAITING_REVIEW'] } },
    }),
    db.intakeUpload.findMany({
      where: { tenantId, venueId, status: { in: ['PRECHECK_PASSED', 'AWAITING_REVIEW'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      select: { fileName: true },
    }),
    db.agentQuestion.count({ where: { tenantId, venueId, status: 'PENDING' } }),
  ])
  const packages = Object.fromEntries(
    packageRows.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>
  const publicContentCount = venue._count.places + venue._count.knowledgeEntries
  const lifecycle = resolveClientPortalLifecycle({
    isActive: venue.isActive,
    publicContentCount,
    wasLive: Boolean(wasLive) && (publicContentCount > 0 || (packages.APPLIED ?? 0) > 0),
    collectingSourceCount: statusTotal(mediaRows, ['DRAFT', 'UPLOADING', 'NEEDS_INPUT']),
    processingSourceCount: statusTotal(mediaRows, [
      'QUEUED',
      'INVENTORYING',
      'ANALYZING',
      'SYNTHESIZING',
    ]),
    reviewSourceCount: statusTotal(mediaRows, ['READY_FOR_REVIEW', 'COMPLETE']),
    intakeProposalCount,
    packageCounts: {
      draft: packages.DRAFT ?? 0,
      approved: packages.APPROVED ?? 0,
      applied: packages.APPLIED ?? 0,
      reverted: packages.REVERTED ?? 0,
    },
    hasActiveOffboarding: Boolean(activeOffboarding),
  })

  const stage = pendingQuestionCount
    ? 'QUESTIONS'
    : lifecycle.state === 'SETUP_REQUESTED'
      ? 'WELCOME'
      : lifecycle.state === 'COLLECTING'
        ? 'SHARE'
        : ['PROCESSING', 'INTERNAL_REVIEW', 'REVISIONS'].includes(lifecycle.state)
          ? 'PROCESSING'
          : ['CLIENT_PREVIEW', 'READY'].includes(lifecycle.state)
            ? 'READY'
            : lifecycle.state === 'LIVE'
              ? 'LIVE'
              : 'PAUSED'
  const currentAction =
    lifecycle.clientAction === 'CONTINUE_INTAKE'
      ? 'Share or review venue information.'
      : lifecycle.clientAction === 'OPEN_PREVIEW'
        ? 'Review the visitor experience.'
        : lifecycle.clientAction === 'CONTACT_SUPPORT'
          ? 'Contact Help & changes.'
          : undefined

  return {
    venue: {
      id: venue.id,
      name: venue.name,
      tonePreset: venue.tonePreset,
      presentationMode: venue.venueBotConfiguration?.presentationMode ?? 'CLASSIC',
    },
    lifecycle: {
      stage,
      summary: `${lifecycle.label}. ${lifecycle.summary}`,
      ...(currentAction ? { currentAction } : {}),
    },
    uploads: { total: uploadCount, recent: recentUploads },
    pendingQuestionCount,
  }
}

async function clientContext(ctx: TenantContext, venueId: string) {
  return ctx.db.$transaction(
    async (db) =>
      buildClientAssistantContext(await loadContextSource(db, ctx.session.activeTenantId, venueId)),
    { isolationLevel: 'RepeatableRead' },
  )
}

function storedReply(turn: {
  assistantMessage: string | null
  questionCategory: string | null
  safeActions: unknown
}): ClientAssistantClientReply {
  if (!turn.assistantMessage || !turn.questionCategory)
    throw new TRPCError({ code: 'CONFLICT', message: 'Client assistant response is incomplete' })
  const category = z
    .enum([
      'upload-guidance',
      'upload-status',
      'portal-navigation',
      'venue-bot-presentation',
      'venue-bot-personality',
      'support-handoff',
      'general-help',
    ])
    .parse(turn.questionCategory)
  const actions = z.array(replyActionSchema).max(3).parse(turn.safeActions)
  const action = actions[0]
  return {
    answer: turn.assistantMessage,
    category,
    ...(action
      ? {
          action:
            action.type === 'navigate'
              ? action
              : {
                  type: action.type,
                  category: action.category,
                  summary: action.summary,
                  requestedOutcome: action.requestedOutcome,
                  ...(action.relevantFeature ? { relevantFeature: action.relevantFeature } : {}),
                },
        }
      : {}),
  }
}

async function recentHistory(ctx: TenantContext, threadId: string, venueId: string) {
  const turns = await ctx.db.clientAssistantTurn.findMany({
    where: {
      tenantId: ctx.session.activeTenantId,
      venueId,
      threadId,
      status: 'COMPLETED',
      thread: { userId: ctx.session.userId },
    },
    orderBy: [{ sequence: 'desc' }],
    take: 4,
    select: { userMessage: true, assistantMessage: true },
  })
  return boundedClientAssistantHistory(
    turns
      .reverse()
      .flatMap((turn) => [
        { role: 'user' as const, content: turn.userMessage },
        ...(turn.assistantMessage
          ? [{ role: 'assistant' as const, content: turn.assistantMessage }]
          : []),
      ]),
  )
}

function safeActions(reply: ClientAssistantClientReply): Array<Record<string, unknown>> {
  return reply.action ? [reply.action] : []
}

export const clientAssistantRouter = router({
  bootstrap: tenantProcedure
    .input(z.object({ venueId: scopedId.optional() }).strict())
    .query(async ({ ctx, input }) => {
      const tenantCtx = ctx as TenantContext
      const available = await clientTochiAvailable(tenantCtx)
      if (!available) {
        return {
          available: false as const,
          venues: [],
          selectedVenueId: null,
          preference: { enabled: false, minimized: false, revision: 0 },
          history: [],
        }
      }
      const venues = await ctx.db.venue.findMany({
        where: { tenantId: ctx.session.activeTenantId, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 101,
        select: { id: true, name: true },
      })
      if (venues.length > 100)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Client assistance exceeds safe venue limits',
        })
      const selected = input.venueId
        ? venues.find((venue) => venue.id === input.venueId)
        : venues[0]
      if (input.venueId && !selected)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Client assistance is not available' })
      const preference = await ctx.db.clientAssistantPreference.findUnique({
        where: {
          tenantId_userId: {
            tenantId: ctx.session.activeTenantId,
            userId: ctx.session.userId,
          },
        },
        select: { enabled: true, minimized: true, revision: true },
      })
      const history = selected
        ? await ctx.db.clientAssistantTurn.findMany({
            where: {
              tenantId: ctx.session.activeTenantId,
              venueId: selected.id,
              status: { in: ['COMPLETED', 'FAILED'] },
              thread: { userId: ctx.session.userId, status: 'ACTIVE' },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 20,
            select: {
              id: true,
              userMessage: true,
              assistantMessage: true,
              questionCategory: true,
              safeActions: true,
              status: true,
              createdAt: true,
            },
          })
        : []
      return {
        available: true as const,
        venues,
        selectedVenueId: selected?.id ?? null,
        preference: preference ?? { enabled: true, minimized: false, revision: 0 },
        history: history.reverse().map((turn) => ({
          id: turn.id,
          userMessage: turn.userMessage,
          assistantMessage: turn.assistantMessage,
          category: turn.questionCategory,
          status: turn.status,
          createdAt: turn.createdAt,
          ...(turn.assistantMessage && turn.questionCategory
            ? { action: storedReply(turn).action }
            : {}),
        })),
      }
    }),

  opened: tenantProcedure
    .input(z.object({ venueId: scopedId }).strict())
    .mutation(async ({ ctx, input }) => {
      const tenantCtx = ctx as TenantContext
      await requireClientTochiAvailable(tenantCtx)
      await requirePreferenceEnabled(tenantCtx)
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: ctx.session.activeTenantId, isActive: true },
        select: { id: true },
      })
      if (!venue)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Client assistance is not available' })
      await emitEvent({
        tenantId: ctx.session.activeTenantId,
        venueId: input.venueId,
        eventType: 'client_tochi_opened',
      })
      return { ok: true }
    }),

  setPreference: tenantProcedure
    .input(
      z
        .object({
          venueId: scopedId,
          enabled: z.boolean(),
          minimized: z.boolean(),
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantCtx = ctx as TenantContext
      await requireClientTochiAvailable(tenantCtx)
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: ctx.session.activeTenantId, isActive: true },
        select: { id: true },
      })
      if (!venue)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Client assistance is not available' })
      try {
        const preference = await setClientAssistantPreferenceAction(
          {
            tenantId: ctx.session.activeTenantId,
            enabled: input.enabled,
            minimized: input.minimized,
            expectedRevision: input.expectedRevision,
            actor: actor(tenantCtx),
          },
          ctx.db,
        )
        if (!input.enabled) {
          await emitEvent({
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            eventType: 'client_tochi_disabled',
          })
        }
        return preference
      } catch (error) {
        actionError(error)
      }
    }),

  send: tenantProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          venueId: scopedId,
          message: z.string(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantCtx = ctx as TenantContext
      await requireClientTochiAvailable(tenantCtx)
      await requirePreferenceEnabled(tenantCtx)
      const message = parseClientTochiQuestion(input.message)
      let reservation
      try {
        reservation = await reserveClientAssistantTurnAction(
          {
            operationId: input.operationId,
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            behaviorVersion: CLIENT_TOCHI_BEHAVIOR_VERSION,
            userMessage: message,
            actor: actor(tenantCtx),
          },
          ctx.db,
        )
      } catch (error) {
        actionError(error)
      }
      if (reservation.replayed && ['COMPLETED', 'FAILED'].includes(reservation.turn.status)) {
        return {
          id: reservation.turn.id,
          threadId: reservation.turn.threadId,
          ...storedReply(reservation.turn),
          replayed: true,
        }
      }

      const generationLeaseId = randomUUID()
      let claim
      try {
        claim = await claimClientAssistantTurnGenerationAction(
          {
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            turnId: reservation.turn.id,
            generationLeaseId,
            actor: actor(tenantCtx),
          },
          ctx.db,
        )
      } catch (error) {
        actionError(error)
      }

      const context = await clientContext(tenantCtx, input.venueId)
      const history = await recentHistory(tenantCtx, reservation.turn.threadId, input.venueId)
      let reply: ClientAssistantClientReply
      let outcome:
        | { status: 'COMPLETED' }
        | { status: 'FAILED'; failureCode: ClientAssistantFailureCode }
      const deterministic = resolveDeterministicClientTochiResponse(message, context)
      if (deterministic) {
        reply = projectClientTochiResponse(deterministic, context)
        outcome = { status: 'COMPLETED' }
      } else {
        const accounting = createApiAiUsageRecorder({
          db: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          clientAssistantTurnId: reservation.turn.id,
          feature: 'client-tochi',
          surface: 'client-portal',
        })
        try {
          const result = await generateText({
            modelKey: AI_MODEL_KEYS.CLIENT_TOCHI,
            system: [...buildClientTochiSystemBlocks(context)],
            messages: [...history, { role: 'user', content: message }],
            usageSink: accounting.sink,
            budgetGate: accounting.budgetGate,
            admissionGuard: () =>
              assertVenueAiAvailable(ctx.db, {
                tenantId: ctx.session.activeTenantId,
                venueId: input.venueId,
              }),
            invocationId: generationLeaseId,
            parseResponse: parseClientTochiResponse,
            onBeforeFirstDispatch: async () => {
              await markClientAssistantTurnProviderDispatchedAction(
                {
                  tenantId: ctx.session.activeTenantId,
                  venueId: input.venueId,
                  turnId: reservation.turn.id,
                  generationLeaseId,
                  actor: actor(tenantCtx),
                },
                ctx.db,
              )
            },
          })
          reply = projectClientTochiResponse(result.parsed, context)
          outcome = { status: 'COMPLETED' }
        } catch {
          reply = safeClientTochiFailureReply()
          outcome = { status: 'FAILED', failureCode: 'assistant-unavailable' }
        }
      }

      try {
        await completeClientAssistantTurnAction(
          {
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            turnId: reservation.turn.id,
            generationLeaseId,
            expectedRevision: claim.claim.revision,
            assistantMessage: reply.answer,
            questionCategory: reply.category,
            safeActions: safeActions(reply),
            outcome,
            actor: actor(tenantCtx),
          },
          ctx.db,
        )
      } catch (error) {
        actionError(error)
      }
      await emitEvent({
        tenantId: ctx.session.activeTenantId,
        venueId: input.venueId,
        eventType: 'client_tochi_message_sent',
        metadata: {
          category: reply.category,
          deterministic: Boolean(deterministic),
          result: outcome.status,
          action: reply.action?.type ?? 'none',
        },
      })
      return {
        id: reservation.turn.id,
        threadId: reservation.turn.threadId,
        ...reply,
        replayed: false,
      }
    }),

  confirmHandoff: tenantProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          venueId: scopedId,
          turnId: scopedId,
          category: supportCategory,
          summary: z.string().trim().min(1).max(200),
          requestedOutcome: z.string().trim().min(1).max(1_000),
          relevantFeature: z.string().trim().min(1).max(100).optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantCtx = ctx as TenantContext
      await requireClientTochiAvailable(tenantCtx)
      await requirePreferenceEnabled(tenantCtx)
      const turn = await ctx.db.clientAssistantTurn.findFirst({
        where: {
          id: input.turnId,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          status: 'COMPLETED',
          thread: { userId: ctx.session.userId },
        },
        select: { id: true, threadId: true, safeActions: true },
      })
      if (!turn)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Handoff preview is not available' })
      const actions = z.array(replyActionSchema).max(3).parse(turn.safeActions)
      const matchingPreview = actions.some(
        (action) =>
          action.type === 'preview-support-handoff' &&
          action.category === input.category &&
          action.summary === input.summary &&
          action.requestedOutcome === input.requestedOutcome &&
          (action.relevantFeature ?? null) === (input.relevantFeature ?? null),
      )
      if (!matchingPreview)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Handoff preview changed; review it again',
        })
      const history = await recentHistory(tenantCtx, turn.threadId, input.venueId)
      const excerpt = safeHandoffExcerpt(history)
      const snapshot = {
        schemaVersion: 1 as const,
        source: 'CLIENT_TOCHI' as const,
        category: input.category,
        summary: input.summary,
        requestedOutcome: input.requestedOutcome,
        ...(input.relevantFeature ? { relevantFeature: input.relevantFeature } : {}),
        excerpt,
      }
      try {
        const support = await createSupportRequestAction(
          {
            operationId: input.operationId,
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            category: input.category,
            subject: input.summary,
            body: [
              input.requestedOutcome,
              ...(input.relevantFeature ? ['', `Relevant area: ${input.relevantFeature}`] : []),
              '',
              'Prepared from Client Tochi and explicitly confirmed by the client for Torchiko team review.',
            ].join('\n'),
            attachments: [],
            actor: {
              actorType: 'HUMAN',
              participantKind: 'CLIENT',
              actorId: ctx.session.userId,
              auditRole: actor(tenantCtx).auditRole,
            },
          },
          ctx.db,
        )
        const handoff = await linkClientAssistantSupportHandoffAction(
          {
            operationId: input.operationId,
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            turnId: input.turnId,
            supportRequestId: support.request.id,
            summarySnapshot: snapshot,
            actor: actor(tenantCtx),
          },
          ctx.db,
        )
        await emitEvent({
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          eventType: 'client_tochi_handoff_created',
          metadata: { category: input.category, replayed: support.replayed || handoff.replayed },
        })
        return {
          requestId: support.request.id,
          handoffId: handoff.handoff.id,
          replayed: support.replayed || handoff.replayed,
        }
      } catch (error) {
        actionError(error)
      }
    }),
})

import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import {
  CompanyKnowledgeType,
  FounderDecisionCurrentTruthRequest,
  FounderDecisionPacket,
} from '@pathfinder/contracts/company-brain'
import { env } from '@pathfinder/config'
import {
  createAgentTaskAction,
  applyFounderDecisionPacketAction,
  createCompanyKnowledgeCandidateAction,
  db,
  getFounderDecisionCurrentTruth,
  promoteCompanyKnowledgeAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueAgentRun } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const listInput = z
  .object({
    query: z.string().trim().max(500).optional(),
    types: z.array(CompanyKnowledgeType).max(8).default([]),
    status: z.enum(['CURRENT', 'CANDIDATE', 'SUPERSEDED', 'ALL']).default('CURRENT'),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .default({})

const commonCreate = z.object({
  requestId: z.string().uuid(),
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(4000),
  rationale: z.string().trim().min(1).max(10_000),
  affectedSystems: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  effectiveAt: z.string().datetime().optional(),
})

export const adminCompanyBrainRouter = router({
  listCompanyBrain: adminProcedure.input(listInput).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const items = await db.companyKnowledgeItem.findMany({
        where: {
          archivedAt: null,
          ...(input.types.length > 0 ? { type: { in: input.types } } : {}),
          ...(input.status === 'CURRENT'
            ? {
                promotionStatus: 'PROMOTED' as const,
                authority: { notIn: ['HISTORICAL', 'SUPERSEDED'] as const },
              }
            : input.status === 'CANDIDATE'
              ? { promotionStatus: 'CANDIDATE' as const }
              : input.status === 'SUPERSEDED'
                ? { authority: 'SUPERSEDED' as const }
                : {}),
          ...(input.query
            ? {
                OR: [
                  { title: { contains: input.query, mode: 'insensitive' as const } },
                  { summary: { contains: input.query, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: [{ lastConfirmedAt: 'desc' }, { updatedAt: 'desc' }],
        take: input.limit,
        select: {
          id: true,
          type: true,
          title: true,
          summary: true,
          authority: true,
          promotionStatus: true,
          accessScope: true,
          tenantId: true,
          venueId: true,
          organizationId: true,
          effectiveAt: true,
          lastConfirmedAt: true,
          supersededAt: true,
          supersededById: true,
          createdByType: true,
          createdById: true,
          updatedAt: true,
          sources: {
            orderBy: { createdAt: 'desc' },
            take: 3,
            select: { id: true, sourceType: true, sourceId: true, sourceRef: true },
          },
          decision: {
            select: {
              id: true,
              status: true,
              decision: true,
              rationale: true,
              scope: true,
              affectedSystems: true,
              effectiveAt: true,
              supersedesId: true,
            },
          },
          priority: {
            select: {
              id: true,
              status: true,
              rank: true,
              timeHorizon: true,
              ownerId: true,
              rationale: true,
              workstreams: true,
              startsAt: true,
              endsAt: true,
            },
          },
        },
      })
      return {
        schemaVersion: 'company-brain-admin.v1',
        items,
        truncated: items.length === input.limit,
      }
    }),
  ),

  createCompanyDecision: adminProcedure
    .input(
      commonCreate.extend({
        decision: z.string().trim().min(1).max(20_000),
        scope: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .default({}),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const actor = {
          type: 'HUMAN' as const,
          actorId: ctx.session.userId,
          role: 'PLATFORM_ADMIN',
        }
        const candidate = await createCompanyKnowledgeCandidateAction({
          type: 'DECISION',
          title: input.title,
          summary: input.summary,
          body: input.decision,
          accessScope: 'RESTRICTED',
          allowedRoles: ['PLATFORM_ADMIN'],
          authority: 'AUTHORITATIVE_CURRENT',
          effectiveAt: input.effectiveAt ? new Date(input.effectiveAt) : new Date(),
          sourceType: 'HUMAN_ENTRY',
          sourceId: ctx.session.userId,
          idempotencyKey: `company-decision:${input.requestId}`,
          decision: {
            status: 'ACTIVE',
            decision: input.decision,
            rationale: input.rationale,
            scope: input.scope,
            affectedSystems: input.affectedSystems,
            effectiveAt: input.effectiveAt ? new Date(input.effectiveAt) : new Date(),
          },
          actor,
        })
        return promoteCompanyKnowledgeAction(
          {
            knowledgeItemId: candidate.id,
            promotionReason: 'Platform administrator created a current company decision.',
            actor,
          },
          db,
        )
      }),
    ),

  applyFounderDecisionPacket: adminProcedure
    .input(FounderDecisionPacket)
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        applyFounderDecisionPacketAction({
          packet: input,
          actor: { type: 'HUMAN', actorId: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        }),
      ),
    ),

  getFounderDecisionCurrentTruth: adminProcedure
    .input(FounderDecisionCurrentTruthRequest)
    .query(({ input }) => withTenantIsolationBypass(() => getFounderDecisionCurrentTruth(input))),

  createCompanyPriority: adminProcedure
    .input(
      commonCreate.extend({
        rank: z.number().int().min(1).max(10_000).default(100),
        timeHorizon: z.string().trim().min(1).max(191).optional(),
        workstreams: z.array(z.string().trim().min(1).max(191)).max(30).default([]),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const actor = {
          type: 'HUMAN' as const,
          actorId: ctx.session.userId,
          role: 'PLATFORM_ADMIN',
        }
        const candidate = await createCompanyKnowledgeCandidateAction({
          type: 'PRIORITY',
          title: input.title,
          summary: input.summary,
          body: input.summary,
          accessScope: 'RESTRICTED',
          allowedRoles: ['PLATFORM_ADMIN'],
          authority: 'AUTHORITATIVE_CURRENT',
          effectiveAt: input.effectiveAt ? new Date(input.effectiveAt) : new Date(),
          sourceType: 'HUMAN_ENTRY',
          sourceId: ctx.session.userId,
          idempotencyKey: `company-priority:${input.requestId}`,
          priority: {
            status: 'ACTIVE',
            rank: input.rank,
            ...(input.timeHorizon ? { timeHorizon: input.timeHorizon } : {}),
            ownerId: ctx.session.userId,
            rationale: input.rationale,
            workstreams: input.workstreams,
            startsAt: input.effectiveAt ? new Date(input.effectiveAt) : new Date(),
          },
          actor,
        })
        return promoteCompanyKnowledgeAction(
          {
            knowledgeItemId: candidate.id,
            promotionReason: 'Platform administrator created a current company priority.',
            actor,
          },
          db,
        )
      }),
    ),

  queueCompanyMeetingProcessing: adminProcedure
    .input(
      z.object({
        requestId: z.string().uuid(),
        tenantId: z.string().min(1).max(191),
        venueId: z.string().min(1).max(191),
        meetingId: z.string().min(1).max(191),
        agentIdentityId: z.string().min(1).max(191),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const [meeting, identity] = await Promise.all([
          db.companyMeeting.findFirst({
            where: {
              id: input.meetingId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              processingStatus: { in: ['RECEIVED', 'FAILED_RETRYABLE', 'NEEDS_REVIEW'] },
            },
            select: { id: true, title: true, sourceArtifactRef: true },
          }),
          db.agentIdentity.findFirst({
            where: {
              id: input.agentIdentityId,
              tenantId: input.tenantId,
              enabled: true,
              accessCapabilities: { has: 'meetings.process' },
              OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
            },
            select: { id: true },
          }),
        ])
        if (!meeting) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Meeting is not available for processing in the requested scope',
          })
        }
        if (!identity) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Enabled meeting-processing identity is unavailable in scope',
          })
        }
        const task = await createAgentTaskAction(
          {
            operationId: input.requestId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
            promptIdentity: 'company-meeting-processing.v1',
            prompt: [
              `Process CompanyMeeting ${meeting.id} (${meeting.title}).`,
              'Use exact meeting detail and its authorized source artifact only when required.',
              'Record bounded extraction candidates and completion through torchiko.meeting.process.',
              'Do not promote candidates to authoritative knowledge.',
            ].join(' '),
            actor: {
              actorType: 'HUMAN',
              actorId: ctx.session.userId,
              auditRole: 'PLATFORM_ADMIN',
            },
          },
          db,
        )
        const dispatch = await enqueueAgentRun(
          { tenantId: input.tenantId, runId: task.run.id },
          { enabled: env.AGENT_RUNNER_ENABLED },
        )
        return {
          ...task,
          executionTriggered: dispatch.enqueued,
          sourceArtifactAvailable: Boolean(meeting.sourceArtifactRef),
        }
      }),
    ),
})

import { z } from 'zod'
import { db } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { authorized, capabilities, scope } from './agent-workflow-activation-shared'

export const adminAgentWorkflowActivationReadsRouter = router({
  getAgentWorkflowTransitionComposer: adminProcedure
    .input(
      scope
        .extend({
          registryKey: z.string().min(1).max(191),
          targetBefore: z
            .object({ version: z.number().int().min(1), id: z.string().uuid() })
            .strict()
            .optional(),
          limit: z.number().int().min(1).max(20).default(20),
        })
        .strict(),
    )
    .query(({ input }) =>
      authorized(input, async () => {
        const head = await db.agentWorkflowActivationHead.findFirst({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            registryKey: input.registryKey,
          },
          select: {
            registryKey: true,
            revision: true,
            selectedRunCount: true,
            activeVersionId: true,
            activeVersion: {
              select: {
                id: true,
                version: true,
                contentHash: true,
                requiredToolCapabilities: true,
              },
            },
            activationEvent: {
              select: {
                id: true,
                kind: true,
                eventHash: true,
                resultingRevision: true,
                createdAt: true,
              },
            },
          },
        })
        if (!head) return { head: null, rollbackTargets: [], nextTargetBefore: null }

        const targets = await db.agentWorkflowVersion.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            registryKey: input.registryKey,
            ...(head.activeVersionId ? { id: { not: head.activeVersionId } } : {}),
            resultingActivationEvents: {
              some: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                registryKey: input.registryKey,
                kind: { in: ['ACTIVATE', 'ROLLBACK'] },
              },
            },
            ...(input.targetBefore
              ? {
                  OR: [
                    { version: { lt: input.targetBefore.version } },
                    { version: input.targetBefore.version, id: { lt: input.targetBefore.id } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            version: true,
            kind: true,
            manifestHash: true,
            contentHash: true,
            requiredToolCapabilities: true,
            resultingActivationEvents: {
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                registryKey: input.registryKey,
                kind: { in: ['ACTIVATE', 'ROLLBACK'] },
              },
              orderBy: [{ resultingRevision: 'desc' }, { id: 'desc' }],
              take: 1,
              select: {
                id: true,
                kind: true,
                resultingRevision: true,
                eventHash: true,
                createdAt: true,
              },
            },
          },
          orderBy: [{ version: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
        })
        const callable: ReadonlySet<string> = capabilities()
        const page = targets.slice(0, input.limit)
        const last = page.at(-1)
        return {
          head: {
            registryKey: head.registryKey,
            expectedHeadRevision: head.revision,
            selectedRunCount: head.selectedRunCount,
            activeVersion: head.activeVersion,
            activationEvent: head.activationEvent,
            revokeEligible: head.activeVersion !== null,
            availablePriorBaseline: head.activeVersion
              ? {
                  workflowVersionId: head.activeVersion.id,
                  contentHash: head.activeVersion.contentHash,
                }
              : null,
          },
          rollbackTargets: page.map((target) => {
            const lineageEvent = target.resultingActivationEvents[0] ?? null
            const missingCapabilities = target.requiredToolCapabilities.filter(
              (capability) => !callable.has(capability),
            )
            return {
              workflowVersionId: target.id,
              version: target.version,
              kind: target.kind,
              manifestHash: target.manifestHash,
              contentHash: target.contentHash,
              requiredToolCapabilities: target.requiredToolCapabilities,
              artifactIntegrity: 'NOT_CHECKED_BODY_ON_REQUEST' as const,
              lineageEvent,
              compatibility: {
                status:
                  missingCapabilities.length === 0
                    ? ('CURRENTLY_AVAILABLE' as const)
                    : ('MISSING_TOOLS' as const),
                missingCapabilities,
              },
              eligible: lineageEvent !== null && missingCapabilities.length === 0,
            }
          }),
          nextTargetBefore:
            targets.length > input.limit && last ? { version: last.version, id: last.id } : null,
        }
      }),
    ),
  listAgentWorkflowActivations: adminProcedure
    .input(
      scope
        .extend({
          registryKey: z.string().min(1).max(191).optional(),
          limit: z.number().int().min(1).max(50).default(20),
          headAfterRegistryKey: z.string().min(1).max(191).optional(),
          eventBefore: z
            .object({ id: z.string().uuid(), createdAt: z.string().datetime({ offset: true }) })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      authorized(input, async () => {
        const heads = await db.agentWorkflowActivationHead.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.registryKey ? { registryKey: input.registryKey } : {}),
            ...(input.headAfterRegistryKey
              ? { AND: [{ registryKey: { gt: input.headAfterRegistryKey } }] }
              : {}),
          },
          select: {
            registryKey: true,
            revision: true,
            selectedRunCount: true,
            activeVersion: {
              select: {
                id: true,
                version: true,
                contentHash: true,
                requiredToolCapabilities: true,
              },
            },
            activationEvent: {
              select: {
                id: true,
                kind: true,
                eventHash: true,
                reason: true,
                createdBy: true,
                createdAt: true,
                approvalDecisionId: true,
                promotionAssessmentId: true,
              },
            },
          },
          orderBy: { registryKey: 'asc' },
          take: input.limit + 1,
        })
        const events = await db.agentWorkflowActivationEvent.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.registryKey ? { registryKey: input.registryKey } : {}),
            ...(input.eventBefore
              ? {
                  OR: [
                    { createdAt: { lt: new Date(input.eventBefore.createdAt) } },
                    {
                      createdAt: new Date(input.eventBefore.createdAt),
                      id: { lt: input.eventBefore.id },
                    },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            registryKey: true,
            kind: true,
            priorVersionId: true,
            resultingVersionId: true,
            priorRevision: true,
            resultingRevision: true,
            eventHash: true,
            reason: true,
            createdBy: true,
            createdAt: true,
            approvalDecisionId: true,
            promotionAssessmentId: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
        })
        const headPage = heads.slice(0, input.limit)
        const eventPage = events.slice(0, input.limit)
        const lastHead = headPage.at(-1)
        const lastEvent = eventPage.at(-1)
        return {
          heads: headPage,
          events: eventPage,
          nextHeadAfterRegistryKey:
            heads.length > input.limit && lastHead ? lastHead.registryKey : null,
          nextEventBefore:
            events.length > input.limit && lastEvent
              ? { id: lastEvent.id, createdAt: lastEvent.createdAt.toISOString() }
              : null,
        }
      }),
    ),
})

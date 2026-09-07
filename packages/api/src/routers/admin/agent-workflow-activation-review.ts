import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { AgentWorkflowPromotionAssessmentDiagnosticsSchema } from '@pathfinder/contracts/agent-workflow-promotion-assessment'
import {
  AgentWorkflowActivationApprovalReceiptSchema,
  AgentWorkflowTransitionApprovalReceiptSchema,
  assertVenueAvailable,
  db,
  isVenueUnavailableError,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { createSafeOperationalMcpRegistry } from '../../mcp/composition'
import { adminProcedure } from '../../trpc'

const cursor = z
  .object({ id: z.string().min(1).max(191), createdAt: z.string().datetime({ offset: true }) })
  .strict()
const inputSchema = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    registryKey: z.string().min(1).max(191).optional(),
    candidateBefore: cursor.optional(),
    requestBefore: cursor.optional(),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict()

const actions = ['agent-workflow.activate', 'agent-workflow.rollback', 'agent-workflow.revoke']
const before = (value: z.output<typeof cursor> | undefined) =>
  value
    ? {
        OR: [
          { createdAt: { lt: new Date(value.createdAt) } },
          { createdAt: new Date(value.createdAt), id: { lt: value.id } },
        ],
      }
    : {}
const next = <T extends { id: string; createdAt: Date }>(rows: T[], limit: number) => {
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    page,
    cursor:
      rows.length > limit && last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null,
  }
}
const artifactShapeValid = (value: unknown) =>
  z
    .array(
      z
        .object({
          kind: z.literal('WORKFLOW_APPROVAL_REQUEST'),
          fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        })
        .strict(),
    )
    .length(1)
    .safeParse(value).success

export const adminAgentWorkflowActivationReviewRouter = router({
  getAgentWorkflowActivationReview: adminProcedure.input(inputSchema).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      try {
        await assertVenueAvailable(db, input)
        const capabilities = new Set<string>(
          createSafeOperationalMcpRegistry()
            .listTools()
            .map((tool) => tool._meta['com.pathfinder/security'].capability),
        )
        const [versionRows, requestRows, identityRows] = await Promise.all([
          db.agentWorkflowVersion.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              ...(input.registryKey ? { registryKey: input.registryKey } : {}),
              ...before(input.candidateBefore),
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: input.limit + 1,
            select: {
              id: true,
              registryKey: true,
              version: true,
              kind: true,
              status: true,
              manifestHash: true,
              contentHash: true,
              requiredToolCapabilities: true,
              createdByType: true,
              createdById: true,
              createdAt: true,
            },
          }),
          db.approvalRequest.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              proposedAction: { in: actions },
              ...(input.registryKey
                ? { scopeSnapshot: { path: ['registryKey'], equals: input.registryKey } }
                : {}),
              ...before(input.requestBefore),
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: input.limit + 1,
            select: {
              id: true,
              agentIdentityId: true,
              requestedByType: true,
              requestedById: true,
              proposedAction: true,
              scopeSnapshot: true,
              reason: true,
              riskCategory: true,
              artifacts: true,
              expiresAt: true,
              createdAt: true,
              decision: {
                select: {
                  id: true,
                  decision: true,
                  decidedByType: true,
                  decidedById: true,
                  reason: true,
                  createdAt: true,
                },
              },
            },
          }),
          db.agentIdentity.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId, enabled: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: 51,
            select: { id: true, identityKey: true, name: true },
          }),
        ])
        const candidates = next(versionRows, input.limit)
        const requests = next(requestRows, input.limit)
        const assessments = await Promise.all(
          candidates.page.map((version) =>
            db.agentWorkflowPromotionAssessment.findFirst({
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                workflowVersionId: version.id,
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: {
                id: true,
                outcome: true,
                assessmentHash: true,
                diagnostics: true,
                createdAt: true,
              },
            }),
          ),
        )
        const parsedRequests = requests.page.map((request) => {
          const parsed =
            request.proposedAction === 'agent-workflow.activate'
              ? AgentWorkflowActivationApprovalReceiptSchema.safeParse(request.scopeSnapshot)
              : AgentWorkflowTransitionApprovalReceiptSchema.safeParse(request.scopeSnapshot)
          const receipt =
            parsed.success &&
            (request.proposedAction === 'agent-workflow.activate' ||
              ('kind' in parsed.data &&
                request.proposedAction === `agent-workflow.${parsed.data.kind.toLowerCase()}`))
              ? parsed
              : { success: false as const }
          return { request, receipt }
        })
        const decisionIds = parsedRequests.flatMap(({ request, receipt }) =>
          receipt.success && request.decision ? [request.decision.id] : [],
        )
        const eventsByDecision = new Map(
          await Promise.all(
            decisionIds.map(
              async (approvalDecisionId) =>
                [
                  approvalDecisionId,
                  await db.agentWorkflowActivationEvent.findMany({
                    where: { tenantId: input.tenantId, venueId: input.venueId, approvalDecisionId },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    take: 2,
                    select: {
                      id: true,
                      registryKey: true,
                      kind: true,
                      resultingRevision: true,
                      eventHash: true,
                      approvalDecisionId: true,
                      createdAt: true,
                    },
                  }),
                ] as const,
            ),
          ),
        )
        const keys = [
          ...new Set([
            ...candidates.page.map((version) => version.registryKey),
            ...parsedRequests.flatMap(({ receipt }) =>
              receipt.success ? [receipt.data.registryKey] : [],
            ),
          ]),
        ].slice(0, 40)
        const heads = keys.length
          ? await db.agentWorkflowActivationHead.findMany({
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                registryKey: { in: keys },
              },
              take: 40,
              select: {
                registryKey: true,
                revision: true,
                activeVersionId: true,
                activationEventId: true,
              },
            })
          : []
        const now = new Date()
        return {
          candidates: candidates.page.map((version, index) => {
            const assessment = assessments[index]
            const diagnostics = assessment
              ? AgentWorkflowPromotionAssessmentDiagnosticsSchema.safeParse(assessment.diagnostics)
              : null
            const missingCapabilities = version.requiredToolCapabilities.filter(
              (capability) => !capabilities.has(capability),
            )
            return {
              version: { ...version, artifactIntegrity: 'NOT_CHECKED_BODY_ON_APPLY' as const },
              compatibility: {
                status:
                  missingCapabilities.length === 0
                    ? ('CURRENTLY_AVAILABLE' as const)
                    : ('MISSING_TOOLS' as const),
                missingCapabilities,
              },
              assessment: assessment
                ? {
                    id: assessment.id,
                    outcome: assessment.outcome,
                    assessmentHash: assessment.assessmentHash,
                    diagnosticsShapeValid: diagnostics?.success ?? false,
                    diagnostics: diagnostics?.success ? diagnostics.data : null,
                    createdAt: assessment.createdAt,
                    applicability: 'HISTORICAL_EVIDENCE_APPLY_REVALIDATES' as const,
                  }
                : null,
            }
          }),
          nextCandidateBefore: candidates.cursor,
          enabledIdentities: identityRows.slice(0, 50),
          identitiesTruncated: identityRows.length > 50,
          approvalRequests: parsedRequests.map(({ request, receipt }) => {
            const decision = request.decision
            const appliedEvents = decision ? (eventsByDecision.get(decision.id) ?? []) : []
            const reviewedApplyInput =
              receipt.success &&
              artifactShapeValid(request.artifacts) &&
              request.requestedByType === 'HUMAN' &&
              decision?.decision === 'APPROVED' &&
              decision.decidedByType === 'HUMAN' &&
              (!request.expiresAt || request.expiresAt > now) &&
              appliedEvents.length === 0
                ? { approvalDecisionId: decision.id, receipt: receipt.data }
                : null
            return {
              id: request.id,
              agentIdentityId: request.agentIdentityId,
              requestedByType: request.requestedByType,
              requestedById: request.requestedById,
              proposedAction: request.proposedAction,
              reason: request.reason,
              riskCategory: request.riskCategory,
              expiresAt: request.expiresAt,
              createdAt: request.createdAt,
              receiptShapeValid: receipt.success,
              artifactShapeValid: artifactShapeValid(request.artifacts),
              receipt: receipt.success ? receipt.data : null,
              decision,
              reviewedApplyInput,
              appliedEventCorrelation:
                appliedEvents.length > 1
                  ? ('AMBIGUOUS' as const)
                  : appliedEvents.length === 1
                    ? ('APPLIED' as const)
                    : ('NONE' as const),
              appliedEvent: appliedEvents.length === 1 ? appliedEvents[0] : null,
            }
          }),
          nextRequestBefore: requests.cursor,
          heads,
        }
      } catch (error) {
        if (error instanceof TRPCError) throw error
        if (!isVenueUnavailableError(error))
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Workflow activation review could not be loaded',
          })
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Workflow activation review is unavailable for this venue',
        })
      }
    }),
  ),
})

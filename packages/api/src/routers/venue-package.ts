import { randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { AiGatewayError } from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import type { MachineActorContext } from '@pathfinder/contracts/actor'
import {
  getVenuePackageSemanticCoverage,
  assertGlobalAiAvailable,
  lockVenueContentMutation,
  recordOrReplayOnboardingMilestoneEvent,
  writeAuditLogStrict,
  VENUE_PACKAGE_TRANSACTION_OPTIONS,
} from '@pathfinder/db'

import {
  VenuePackageApprovalInput,
  VenuePackageByIdInput,
  VenuePackageDraftInput,
  VenuePackageLifecycleInput,
  VenuePackagePayload,
  VenuePackagePreviewInput,
  VenuePackageStoredPreview,
  VenuePackageValidationReport,
  type VenuePackageIssue,
} from '../schemas/venue-package'
import { mergeRouters, router } from '../core'
import type { TRPCContext } from '../context'
import { createApiAiUsageRecorder } from '../lib/api-ai-usage'
import { venuePackagePayloadHash } from '../lib/venue-package-identity'
import {
  type VenuePackageDraftFinalizer,
  VenuePackageDraftFinalizerError,
} from '../lib/venue-package-draft-finalizer'
import {
  analyzeVenuePackageSemanticDuplicates,
  buildIncompleteSemanticScan,
  generateVenuePackageCandidateEmbeddings,
  sortVenuePackageIssues,
  venuePackageSemanticInputs,
  VENUE_PACKAGE_SEMANTIC_PROFILES,
  VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
} from '../lib/venue-package-semantic-analysis'
import {
  applyVenuePackageLifecycle,
  approveVenuePackageLifecycle,
  assertVenue,
  auditState,
  buildVenuePackagePreview,
  conflict,
  digest,
  findPackage,
  jsonValue,
  parseStoredVenuePackagePreview,
  revertVenuePackageLifecycle,
} from '../lib/venue-package-core'

// One implementation: drafts, approvals and applies must build identical evidence.
export {
  assertStoredVenuePackageEvidenceCurrent,
  buildVenuePackagePreview,
  latestTargetVersions,
  parseStoredVenuePackagePreview,
  VenuePackageApprovedBaseStaleError,
} from '../lib/venue-package-core'
import { contentVersionActor } from '../middleware/content-version-actor'
import { requireGlobalAi } from '../middleware/require-global-ai'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type DbClient = TRPCContext['db']
const withVenuePackageContentVersionActor = contentVersionActor(VENUE_PACKAGE_TRANSACTION_OPTIONS)
type PackagePayload = VenuePackagePayload
type VenuePackageDraftActor =
  | { type: 'HUMAN'; id: string; role: 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN' }
  | MachineActorContext

const venuePackageSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  draftKey: true,
  schemaVersion: true,
  payload: true,
  payloadHash: true,
  baseDigest: true,
  validationReport: true,
  previewPlan: true,
  status: true,
  createdBy: true,
  approvedBy: true,
  approvedAt: true,
  approvedCommandKey: true,
  approvalWarningDigest: true,
  approvedWarningCodes: true,
  appliedBy: true,
  appliedAt: true,
  appliedCommandKey: true,
  appliedEntities: true,
  revertedBy: true,
  revertedAt: true,
  revertedCommandKey: true,
  createdAt: true,
  updatedAt: true,
} as const

function semanticCoverageParams(payload: PackagePayload) {
  const inputs = venuePackageSemanticInputs(payload)
  return {
    scanPlaces: inputs.places.length > 0,
    scanKnowledgeEntries: inputs.knowledgeEntries.length > 0,
    ...(payload.schemaVersion === 3
      ? {
          excludedPlaceIds: [...payload.places.update, ...payload.places.delete].map(
            (operation) => operation.id,
          ),
          excludedKnowledgeEntryIds: [
            ...payload.knowledgeEntries.update,
            ...payload.knowledgeEntries.delete,
          ].map((operation) => operation.id),
        }
      : {}),
  }
}

function withSemanticEvidence(
  preview: Awaited<ReturnType<typeof buildVenuePackagePreview>>,
  semantic: {
    scan: VenuePackageValidationReport['semanticDuplicateScan']
    errors?: VenuePackageIssue[]
    warnings?: VenuePackageIssue[]
  },
) {
  const report = VenuePackageValidationReport.parse({
    errors: sortVenuePackageIssues([...preview.report.errors, ...(semantic.errors ?? [])]),
    warnings: sortVenuePackageIssues([...preview.report.warnings, ...(semantic.warnings ?? [])]),
    semanticDuplicateScan: semantic.scan,
  })
  return VenuePackageStoredPreview.parse({
    ...preview,
    report,
    warningDigest: digest(report.warnings),
  })
}

export const venuePackageReadRouter = router({
  preview: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackagePreviewInput)
    .mutation(({ ctx, input }) =>
      buildVenuePackagePreview(ctx.db, ctx.session.activeTenantId, input.venueId, input.payload),
    ),

  list: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackagePreviewInput.pick({ venueId: true }))
    .query(async ({ ctx, input }) => {
      await assertVenue(ctx.db, ctx.session.activeTenantId, input.venueId)
      const packages = await ctx.db.venuePackage.findMany({
        where: { tenantId: ctx.session.activeTenantId, venueId: input.venueId },
        select: venuePackageSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 100,
      })
      return packages.map((pkg) => {
        const preview = parseStoredVenuePackagePreview(pkg)
        return { ...pkg, validationReport: preview.report, previewPlan: preview }
      })
    }),

  getById: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackageByIdInput)
    .query(async ({ ctx, input }) => {
      const pkg = await findPackage(ctx.db, ctx.session.activeTenantId, input.id)
      if (!pkg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      const preview = parseStoredVenuePackagePreview(pkg)
      return { ...pkg, validationReport: preview.report, previewPlan: preview }
    }),
})

async function runExplicitFinalizer(
  finalizer: VenuePackageDraftFinalizer | undefined,
  input: Parameters<VenuePackageDraftFinalizer>[0],
) {
  if (!finalizer) return undefined
  try {
    return await finalizer(input)
  } catch (error) {
    throw new VenuePackageDraftFinalizerError(error)
  }
}

export async function createVenuePackageDraftService(request: {
  db: DbClient
  tenantId: string
  actor: VenuePackageDraftActor
  input: typeof VenuePackageDraftInput._output
  finalizer?: VenuePackageDraftFinalizer
  isolationLevel?: 'ReadCommitted' | 'Serializable'
}) {
  const { db, tenantId, actor, input, finalizer } = request
  const actorId = actor.type === 'AGENT' ? actor.actorId : actor.id
  await assertGlobalAiAvailable(db)
  const key = {
    tenantId,
    venueId: input.venueId,
    draftKey: input.draftKey,
  }
  const requestedPayloadHash = venuePackagePayloadHash(input.venueId, input.payload)
  const claimToken = randomUUID()

  let prepared
  try {
    prepared = await db.$transaction(
      async (transaction) => {
        await lockVenueContentMutation(transaction, { tenantId, venueId: input.venueId })
        const existingPackage = await transaction.venuePackage.findFirst({
          where: key,
          select: venuePackageSelect,
        })
        if (existingPackage) {
          if (existingPackage.payloadHash !== requestedPayloadHash) {
            conflict('Draft key was already used for different venue-package content')
          }
          const existingPreview = parseStoredVenuePackagePreview(existingPackage)
          const attachment = await runExplicitFinalizer(finalizer, {
            tx: transaction as DbClient,
            packageId: existingPackage.id,
            tenantId,
            venueId: input.venueId,
            status: existingPackage.status,
            createdBy: existingPackage.createdBy,
            preview: existingPreview,
            replayed: true,
          })
          return {
            kind: 'complete' as const,
            pkg: existingPackage,
            preview: existingPreview,
            replayed: true,
            attachment,
          }
        }

        const preview = await buildVenuePackagePreview(
          transaction as DbClient,
          tenantId,
          input.venueId,
          input.payload,
        )
        const existingAnalysis = await transaction.venuePackageDuplicateAnalysis.findFirst({
          where: key,
          select: {
            status: true,
            payloadHash: true,
            baseDigest: true,
            errorCode: true,
          },
        })
        if (existingAnalysis) {
          if (
            existingAnalysis.payloadHash !== preview.payloadHash ||
            existingAnalysis.baseDigest !== preview.baseDigest
          ) {
            conflict('Draft key was already used for different venue-package content or base')
          }
          if (existingAnalysis.status === 'RUNNING') {
            return { kind: 'running' as const }
          }
          return { kind: 'terminal-failure' as const, status: existingAnalysis.status }
        }

        const coverage = await getVenuePackageSemanticCoverage(transaction, {
          tenantId,
          venueId: input.venueId,
          placeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
          knowledgeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
          ...semanticCoverageParams(input.payload),
        })
        const incomplete = buildIncompleteSemanticScan({ payload: input.payload, coverage })
        if (incomplete.errors.length > 0) {
          const finalPreview = withSemanticEvidence(preview, incomplete)
          const pkg = await transaction.venuePackage.create({
            data: {
              ...key,
              schemaVersion: input.payload.schemaVersion,
              payload: jsonValue(input.payload),
              payloadHash: finalPreview.payloadHash,
              baseDigest: finalPreview.baseDigest,
              validationReport: jsonValue(finalPreview.report),
              previewPlan: jsonValue(finalPreview),
              createdBy: actorId,
            },
            select: venuePackageSelect,
          })
          const attachment = await runExplicitFinalizer(finalizer, {
            tx: transaction as DbClient,
            packageId: pkg.id,
            tenantId,
            venueId: input.venueId,
            status: pkg.status,
            createdBy: pkg.createdBy,
            preview: finalPreview,
            replayed: false,
          })
          await transaction.venuePackageDuplicateAnalysis.create({
            data: {
              ...key,
              payloadHash: finalPreview.payloadHash,
              baseDigest: finalPreview.baseDigest,
              status: 'COMPLETE',
              claimToken,
              embeddingProfiles: jsonValue(VENUE_PACKAGE_SEMANTIC_PROFILES),
              similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
              result: jsonValue(finalPreview),
              usageEventIds: [],
              draftId: pkg.id,
              createdBy: actorId,
              completedAt: new Date(),
            },
          })
          await writeAuditLogStrict(
            actor.type === 'AGENT'
              ? {
                  tenantId,
                  actor,
                  action: 'venue-package.created-draft',
                  targetType: 'VenuePackage',
                  targetId: pkg.id,
                  afterState: auditState(pkg),
                }
              : {
                  tenantId,
                  actorId,
                  actorRole: actor.role,
                  action: 'venue-package.created-draft',
                  targetType: 'VenuePackage',
                  targetId: pkg.id,
                  afterState: auditState(pkg),
                },
            transaction as DbClient,
          )
          return {
            kind: 'complete' as const,
            pkg,
            preview: finalPreview,
            replayed: false,
            attachment,
          }
        }

        const analysis = await transaction.venuePackageDuplicateAnalysis.create({
          data: {
            ...key,
            payloadHash: preview.payloadHash,
            baseDigest: preview.baseDigest,
            claimToken,
            embeddingProfiles: jsonValue(VENUE_PACKAGE_SEMANTIC_PROFILES),
            similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
            createdBy: actorId,
          },
          select: { id: true },
        })
        return { kind: 'claimed' as const, analysisId: analysis.id, preview }
      },
      {
        ...VENUE_PACKAGE_TRANSACTION_OPTIONS,
        isolationLevel: request.isolationLevel ?? 'ReadCommitted',
      },
    )
  } catch (error) {
    if (error instanceof VenuePackageDraftFinalizerError) throw error.cause
    throw error
  }

  if (prepared.kind === 'complete') {
    return {
      value: { ...prepared.pkg, preview: prepared.preview, replayed: prepared.replayed },
      attachment: prepared.attachment,
    }
  }
  if (prepared.kind === 'running') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Duplicate analysis is already running for this draft key.',
    })
  }
  if (prepared.kind === 'terminal-failure') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This draft key has terminal duplicate-analysis evidence; use a new key.',
    })
  }

  const usage = createApiAiUsageRecorder({
    db,
    tenantId,
    venueId: input.venueId,
    feature: 'venue-package-duplicate-analysis',
    surface: 'client-dashboard',
  })

  type DuplicateAnalysisFailureCode =
    | 'usage-persistence-failed'
    | 'provider-configuration-required'
    | 'provider-connection-failed'
    | 'provider-request-aborted'
    | 'provider-invalid-response'
    | 'provider-request-failed'
    | 'unexpected-error'
    | 'attachment-finalization-failed'
    | 'finalization-failed'

  const providerFailureCode = (error: AiGatewayError): DuplicateAnalysisFailureCode => {
    if (
      error.code === 'provider-not-configured' ||
      error.code === 'provider-client-initialization'
    ) {
      return 'provider-configuration-required'
    }
    if (
      error.code === 'provider-connection-timeout' ||
      error.code === 'provider-connection-error'
    ) {
      return 'provider-connection-failed'
    }
    if (error.code === 'provider-user-abort') return 'provider-request-aborted'
    if (
      error.code === 'missing-text-block' ||
      error.code === 'invalid-structured-output' ||
      error.code === 'invalid-provider-response' ||
      error.code === 'provider-incomplete-response'
    ) {
      return 'provider-invalid-response'
    }
    return 'provider-request-failed'
  }

  const settleFailure = async (errorCode: DuplicateAnalysisFailureCode) => {
    try {
      await db.venuePackageDuplicateAnalysis.updateMany({
        where: {
          id: prepared.analysisId,
          tenantId,
          venueId: input.venueId,
          status: 'RUNNING',
          claimToken,
        },
        data: {
          status: 'FAILED',
          errorCode,
          usageEventIds: jsonValue(usage.usageEventIds()),
          completedAt: new Date(),
        },
      })
    } catch {
      // A failed settlement leaves an intentionally ambiguous RUNNING claim.
      // It must never be auto-redriven because provider idempotency is unavailable.
      logger.error({
        action: 'venue_package.duplicate_analysis.settlement_failed',
        tenantId,
        venueId: input.venueId,
        analysisId: prepared.analysisId,
        terminalStatus: 'FAILED',
        error: 'Duplicate-analysis settlement failed',
      })
    }
  }

  let candidates
  try {
    candidates = await generateVenuePackageCandidateEmbeddings({
      payload: input.payload,
      usageSink: usage.sink,
      // Package authoring must work before a draft venue is visible to guests. The preparation
      // and finalization transactions check its scoped existence and content version; keep the
      // global AI pause and budget gates without requiring visitor availability.
      admissionGuard: async () => {
        await assertGlobalAiAvailable(db)
        await assertVenue(db, tenantId, input.venueId)
      },
      budgetGate: usage.budgetGate,
      shouldAbort: usage.persistenceFailed,
    })
    if (usage.persistenceFailed()) {
      await settleFailure('usage-persistence-failed')
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Duplicate analysis could not be recorded; no draft was saved.',
      })
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error
    const errorCode = usage.persistenceFailed()
      ? 'usage-persistence-failed'
      : error instanceof AiGatewayError
        ? providerFailureCode(error)
        : 'unexpected-error'
    logger.warn({
      action: 'venue_package.duplicate_analysis.failed',
      tenantId,
      venueId: input.venueId,
      analysisId: prepared.analysisId,
      errorType: error instanceof Error ? error.name : typeof error,
      errorCode,
      usagePersistenceFailed: usage.persistenceFailed(),
    })
    await settleFailure(errorCode)
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message:
        errorCode === 'provider-configuration-required'
          ? 'The embedding provider is not configured; no draft was saved.'
          : 'Duplicate analysis could not complete; no draft was saved.',
    })
  }

  try {
    const finalized = await db.$transaction(
      async (transaction) => {
        await lockVenueContentMutation(transaction, { tenantId, venueId: input.venueId })
        const preview = await buildVenuePackagePreview(
          transaction as DbClient,
          tenantId,
          input.venueId,
          input.payload,
        )
        const analysis = await transaction.venuePackageDuplicateAnalysis.findFirst({
          where: {
            id: prepared.analysisId,
            tenantId,
            venueId: input.venueId,
            status: 'RUNNING',
            claimToken,
          },
          select: { id: true, payloadHash: true, baseDigest: true },
        })
        if (!analysis) conflict('Duplicate-analysis claim is no longer active')
        if (
          analysis.payloadHash !== preview.payloadHash ||
          analysis.baseDigest !== preview.baseDigest
        ) {
          await transaction.venuePackageDuplicateAnalysis.updateMany({
            where: {
              id: analysis.id,
              tenantId,
              venueId: input.venueId,
              status: 'RUNNING',
              claimToken,
            },
            data: {
              status: 'STALE',
              errorCode: 'venue-base-changed',
              usageEventIds: jsonValue(usage.usageEventIds()),
              completedAt: new Date(),
            },
          })
          return { kind: 'stale' as const }
        }

        const coverage = await getVenuePackageSemanticCoverage(transaction, {
          tenantId,
          venueId: input.venueId,
          placeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
          knowledgeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
          ...semanticCoverageParams(input.payload),
        })
        const incomplete = buildIncompleteSemanticScan({ payload: input.payload, coverage })
        if (incomplete.errors.length > 0) {
          await transaction.venuePackageDuplicateAnalysis.updateMany({
            where: {
              id: analysis.id,
              tenantId,
              venueId: input.venueId,
              status: 'RUNNING',
              claimToken,
            },
            data: {
              status: 'STALE',
              errorCode: 'semantic-scan-became-incomplete',
              usageEventIds: jsonValue(usage.usageEventIds()),
              completedAt: new Date(),
            },
          })
          return { kind: 'stale' as const }
        }

        const semantic = await analyzeVenuePackageSemanticDuplicates({
          db: transaction as DbClient,
          tenantId,
          venueId: input.venueId,
          payload: input.payload,
          coverage,
          candidates,
        })
        const finalPreview = withSemanticEvidence(preview, semantic)
        const pkg = await transaction.venuePackage.create({
          data: {
            ...key,
            schemaVersion: input.payload.schemaVersion,
            payload: jsonValue(input.payload),
            payloadHash: finalPreview.payloadHash,
            baseDigest: finalPreview.baseDigest,
            validationReport: jsonValue(finalPreview.report),
            previewPlan: jsonValue(finalPreview),
            createdBy: actorId,
          },
          select: venuePackageSelect,
        })
        const completed = await transaction.venuePackageDuplicateAnalysis.updateMany({
          where: {
            id: analysis.id,
            tenantId,
            venueId: input.venueId,
            status: 'RUNNING',
            claimToken,
          },
          data: {
            status: 'COMPLETE',
            result: jsonValue(finalPreview),
            usageEventIds: jsonValue(usage.usageEventIds()),
            draftId: pkg.id,
            completedAt: new Date(),
          },
        })
        if (completed.count !== 1) conflict('Duplicate-analysis completion lost ownership')
        const attachment = await runExplicitFinalizer(finalizer, {
          tx: transaction as DbClient,
          packageId: pkg.id,
          tenantId,
          venueId: input.venueId,
          status: pkg.status,
          createdBy: pkg.createdBy,
          preview: finalPreview,
          replayed: false,
        })
        await writeAuditLogStrict(
          actor.type === 'AGENT'
            ? {
                tenantId,
                actor,
                action: 'venue-package.created-draft',
                targetType: 'VenuePackage',
                targetId: pkg.id,
                afterState: auditState(pkg),
              }
            : {
                tenantId,
                actorId,
                actorRole: actor.role,
                action: 'venue-package.created-draft',
                targetType: 'VenuePackage',
                targetId: pkg.id,
                afterState: auditState(pkg),
              },
          transaction as DbClient,
        )
        await recordOrReplayOnboardingMilestoneEvent({
          db: transaction,
          input: {
            id: randomUUID(),
            tenantId,
            venueId: input.venueId,
            eventType: 'REVIEWABLE_PACKAGE',
            idempotencyKey: `venue-package:${pkg.id}:reviewable`,
            occurredAt: new Date(),
            actorType: actor.type === 'AGENT' ? 'AGENT' : 'OPERATOR',
            actorId,
            sourceType: 'VENUE_PACKAGE',
            sourceId: pkg.id,
            sourceRevision: finalPreview.payloadHash,
            category: null,
            durationMs: null,
          },
        })
        return { kind: 'complete' as const, pkg, preview: finalPreview, attachment }
      },
      {
        ...VENUE_PACKAGE_TRANSACTION_OPTIONS,
        isolationLevel: request.isolationLevel ?? 'ReadCommitted',
      },
    )
    if (finalized.kind === 'stale') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Venue content or embedding coverage changed during analysis; use a new key.',
      })
    }
    return {
      value: { ...finalized.pkg, preview: finalized.preview, replayed: false },
      attachment: finalized.attachment,
    }
  } catch (error) {
    if (error instanceof VenuePackageDraftFinalizerError) {
      await settleFailure('attachment-finalization-failed')
      throw error.cause
    }
    if (error instanceof TRPCError && error.code === 'CONFLICT') {
      throw error
    }
    logger.error({
      action: 'venue_package.duplicate_analysis.finalization_failed',
      tenantId,
      venueId: input.venueId,
      analysisId: prepared.analysisId,
      errorType: error instanceof Error ? error.name : typeof error,
      errorCode:
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'unknown',
      error: 'Duplicate-analysis finalization failed',
    })
    await settleFailure('finalization-failed')
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Duplicate analysis could not be finalized; no draft was saved.',
    })
  }
}

export const venuePackageCreateRouter = router({
  createDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(requireGlobalAi)
    .input(VenuePackageDraftInput)
    .mutation(async ({ ctx, input }) => {
      const result = await createVenuePackageDraftService({
        db: ctx.db,
        tenantId: ctx.session.activeTenantId,
        actor: {
          type: 'HUMAN',
          id: ctx.session.userId,
          role: ctx.session.role === 'OWNER' ? 'OWNER' : 'MANAGER',
        },
        input,
      })
      return result.value
    }),
})

export const venuePackageLifecycleRouter = router({
  approve: tenantProcedure
    .use(requireRole('OWNER'))
    .input(VenuePackageApprovalInput)
    .mutation(({ ctx, input }) =>
      approveVenuePackageLifecycle({
        db: ctx.db,
        tenantId: ctx.session.activeTenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'OWNER' },
        command: input,
      }),
    ),

  applyPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withVenuePackageContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(({ ctx, input }) =>
      applyVenuePackageLifecycle({
        db: ctx.db,
        tenantId: ctx.session.activeTenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'OWNER' },
        command: input,
      }),
    ),

  revertPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withVenuePackageContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(({ ctx, input }) =>
      revertVenuePackageLifecycle({
        db: ctx.db,
        tenantId: ctx.session.activeTenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'OWNER' },
        command: input,
      }),
    ),
})

export const venuePackageRouter = mergeRouters(
  venuePackageReadRouter,
  venuePackageCreateRouter,
  venuePackageLifecycleRouter,
)

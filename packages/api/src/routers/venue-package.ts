import { createHash, randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { AiGatewayError } from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import {
  getVenuePackageSemanticCoverage,
  lockVenueContentMutation,
  writeAuditLogStrict,
} from '@pathfinder/db'

import {
  canonicalVenuePackagePayload,
  VenuePackageApprovalInput,
  VenuePackageAppliedEntities,
  VenuePackageByIdInput,
  VenuePackageDraftInput,
  VenuePackageLifecycleInput,
  VenuePackagePayload,
  VenuePackagePreviewInput,
  VenuePackageStoredPreview,
  VenuePackageValidationReport,
  type VenuePackageIssue,
} from '../schemas/venue-package'
import { router } from '../core'
import type { TRPCContext } from '../context'
import { createApiAiUsageRecorder } from '../lib/api-ai-usage'
import {
  analyzeVenuePackageSemanticDuplicates,
  buildIncompleteSemanticScan,
  buildNotRunSemanticScan,
  generateVenuePackageCandidateEmbeddings,
  sortVenuePackageIssues,
  VENUE_PACKAGE_SEMANTIC_PROFILES,
  VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
} from '../lib/venue-package-semantic-analysis'
import { withContentVersionActor } from '../middleware/content-version-actor'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type DbClient = TRPCContext['db']
type PackagePayload = VenuePackagePayload

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

function conflict(message = 'Venue package changed; refresh and review it again'): never {
  throw new TRPCError({ code: 'CONFLICT', message })
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function jsonValue(value: unknown): object {
  return JSON.parse(JSON.stringify(value)) as object
}

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

async function assertVenue(db: DbClient, tenantId: string, venueId: string) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true, guideMode: true },
  })
  if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
  return venue
}

async function contentState(db: DbClient, tenantId: string, venueId: string) {
  const [places, knowledgeEntries] = await Promise.all([
    db.place.findMany({
      where: { tenantId, venueId },
      select: {
        id: true,
        name: true,
        type: true,
        itemType: true,
        shortDescription: true,
        longDescription: true,
        lat: true,
        lng: true,
        tags: true,
        importanceScore: true,
        areaName: true,
        hours: true,
        photoUrl: true,
        isActive: true,
      },
      orderBy: { id: 'asc' },
    }),
    db.venueKnowledgeEntry.findMany({
      where: { tenantId, venueId },
      select: { id: true, title: true, category: true, content: true, isEnabled: true },
      orderBy: { id: 'asc' },
    }),
  ])
  return { places, knowledgeEntries }
}

async function contentStateDigest(db: DbClient, tenantId: string, venueId: string) {
  return digest(await contentState(db, tenantId, venueId))
}

function duplicateWarnings(
  payload: PackagePayload,
  current: Awaited<ReturnType<typeof contentState>>,
) {
  const warnings: Array<{ code: string; path: string; message: string }> = []
  const existingPlaceNames = new Set(
    current.places.filter((place) => place.isActive).map((place) => normalizeLabel(place.name)),
  )
  const existingKnowledgeTitles = new Set(
    current.knowledgeEntries.map((entry) => normalizeLabel(entry.title)),
  )

  const seenPlaces = new Set<string>()
  payload.places.forEach((place, index) => {
    const normalized = normalizeLabel(place.name)
    if (seenPlaces.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_IN_PACKAGE',
        path: `places.${index}.name`,
        message: `Another package place has the normalized name “${normalized}”.`,
      })
    } else if (existingPlaceNames.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_EXISTING_CONTENT',
        path: `places.${index}.name`,
        message: `An active venue place already has the normalized name “${normalized}”.`,
      })
    }
    seenPlaces.add(normalized)
  })

  const seenKnowledge = new Set<string>()
  payload.knowledgeEntries.forEach((entry, index) => {
    const normalized = normalizeLabel(entry.title)
    if (seenKnowledge.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_IN_PACKAGE',
        path: `knowledgeEntries.${index}.title`,
        message: `Another package knowledge entry has the normalized title “${normalized}”.`,
      })
    } else if (existingKnowledgeTitles.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_EXISTING_CONTENT',
        path: `knowledgeEntries.${index}.title`,
        message: `Venue knowledge already has the normalized title “${normalized}”.`,
      })
    }
    seenKnowledge.add(normalized)
  })

  return sortVenuePackageIssues(warnings)
}

async function buildPreview(
  db: DbClient,
  tenantId: string,
  venueId: string,
  payload: PackagePayload,
) {
  const venue = await assertVenue(db, tenantId, venueId)
  const current = await contentState(db, tenantId, venueId)
  const errors: Array<{ code: string; path: string; message: string }> = []
  if (
    venue.guideMode === 'location_aware' &&
    payload.places.some((place) => place.lat === undefined || place.lng === undefined)
  ) {
    payload.places.forEach((place, index) => {
      if (place.lat === undefined || place.lng === undefined) {
        errors.push({
          code: 'LOCATION_REQUIRED',
          path: `places.${index}`,
          message: 'Latitude and longitude are required for this location-aware venue.',
        })
      }
    })
  }

  const baseDigest = digest(current)
  const payloadHash = digest(canonicalVenuePackagePayload(venueId, payload))
  const report = VenuePackageValidationReport.parse({
    errors: sortVenuePackageIssues(errors),
    warnings: duplicateWarnings(payload, current),
    semanticDuplicateScan: buildNotRunSemanticScan({
      payload,
      existingPlaceCount: current.places.filter((place) => place.isActive).length,
      existingKnowledgeCount: current.knowledgeEntries.filter((entry) => entry.isEnabled).length,
    }),
  })
  return {
    schemaVersion: payload.schemaVersion,
    payloadHash,
    baseDigest,
    mode: 'ADDITIVE_V1' as const,
    warningDigest: digest(report.warnings),
    report,
    changes: {
      places: { add: payload.places, change: [], remove: [], unchanged: current.places.length },
      knowledgeEntries: {
        add: payload.knowledgeEntries,
        change: [],
        remove: [],
        unchanged: current.knowledgeEntries.length,
      },
    },
  }
}

function withSemanticEvidence(
  preview: Awaited<ReturnType<typeof buildPreview>>,
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

function parseStoredPreview(pkg: { validationReport: unknown; previewPlan: unknown }) {
  const report = VenuePackageValidationReport.safeParse(pkg.validationReport)
  const preview = VenuePackageStoredPreview.safeParse(pkg.previewPlan)
  if (!report.success || !preview.success)
    conflict('Stored venue package review evidence is invalid')
  if (JSON.stringify(report.data) !== JSON.stringify(preview.data.report)) {
    conflict('Stored venue package review evidence is inconsistent')
  }
  return preview.data
}

function isSemanticIssue(issue: VenuePackageIssue): boolean {
  return issue.code.startsWith('SEMANTIC_')
}

function assertStoredEvidenceCurrent(params: {
  stored: VenuePackageStoredPreview
  deterministic: Awaited<ReturnType<typeof buildPreview>>
}): void {
  if (
    params.stored.payloadHash !== params.deterministic.payloadHash ||
    params.stored.baseDigest !== params.deterministic.baseDigest
  ) {
    conflict('Venue content changed; create a new preview')
  }
  const storedExactErrors = params.stored.report.errors.filter((issue) => !isSemanticIssue(issue))
  const storedExactWarnings = params.stored.report.warnings.filter(
    (issue) => !isSemanticIssue(issue),
  )
  if (
    JSON.stringify(storedExactErrors) !== JSON.stringify(params.deterministic.report.errors) ||
    JSON.stringify(storedExactWarnings) !== JSON.stringify(params.deterministic.report.warnings)
  ) {
    conflict('Venue package deterministic validation evidence changed')
  }
}

async function findPackage(db: DbClient, tenantId: string, id: string) {
  return db.venuePackage.findFirst({ where: { id, tenantId }, select: venuePackageSelect })
}

function auditState(pkg: NonNullable<Awaited<ReturnType<typeof findPackage>>>) {
  return {
    id: pkg.id,
    venueId: pkg.venueId,
    schemaVersion: pkg.schemaVersion,
    payloadHash: pkg.payloadHash,
    baseDigest: pkg.baseDigest,
    approvalWarningDigest: pkg.approvalWarningDigest,
    approvedWarningCodes: pkg.approvedWarningCodes,
    status: pkg.status,
    createdBy: pkg.createdBy,
    approvedBy: pkg.approvedBy,
    approvedAt: pkg.approvedAt?.toISOString() ?? null,
    appliedBy: pkg.appliedBy,
    appliedAt: pkg.appliedAt?.toISOString() ?? null,
    revertedBy: pkg.revertedBy,
    revertedAt: pkg.revertedAt?.toISOString() ?? null,
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
  }
}

function parsePayload(value: unknown): PackagePayload {
  const result = VenuePackagePayload.safeParse(value)
  if (!result.success) conflict('Stored venue package payload is invalid')
  return result.data
}

function matchesPlace(
  current: Awaited<ReturnType<typeof contentState>>['places'][number],
  expected: VenuePackageAppliedEntities['places'][number],
) {
  return (
    current.id === expected.id &&
    current.name === expected.name &&
    current.type === expected.type &&
    current.itemType === (expected.itemType ?? null) &&
    current.shortDescription === (expected.shortDescription ?? null) &&
    current.longDescription === (expected.longDescription ?? null) &&
    current.lat === (expected.lat ?? null) &&
    current.lng === (expected.lng ?? null) &&
    JSON.stringify(current.tags) === JSON.stringify(expected.tags) &&
    current.importanceScore === expected.importanceScore &&
    current.areaName === (expected.areaName ?? null) &&
    current.hours === (expected.hours ?? null) &&
    current.photoUrl === (expected.photoUrl ?? null) &&
    current.isActive
  )
}

function matchesKnowledge(
  current: Awaited<ReturnType<typeof contentState>>['knowledgeEntries'][number],
  expected: VenuePackageAppliedEntities['knowledgeEntries'][number],
) {
  return (
    current.id === expected.id &&
    current.title === expected.title &&
    current.category === expected.category &&
    current.content === expected.content &&
    current.isEnabled === expected.isEnabled
  )
}

export const venuePackageRouter = router({
  preview: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackagePreviewInput)
    .mutation(({ ctx, input }) =>
      buildPreview(ctx.db, ctx.session.activeTenantId, input.venueId, input.payload),
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
        const preview = parseStoredPreview(pkg)
        return { ...pkg, validationReport: preview.report, previewPlan: preview }
      })
    }),

  getById: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackageByIdInput)
    .query(async ({ ctx, input }) => {
      const pkg = await findPackage(ctx.db, ctx.session.activeTenantId, input.id)
      if (!pkg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      const preview = parseStoredPreview(pkg)
      return { ...pkg, validationReport: preview.report, previewPlan: preview }
    }),

  createDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackageDraftInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const key = {
        tenantId,
        venueId: input.venueId,
        draftKey: input.draftKey,
      }
      const requestedPayloadHash = digest(
        canonicalVenuePackagePayload(input.venueId, input.payload),
      )
      const claimToken = randomUUID()

      const prepared = await ctx.db.$transaction(async (transaction) => {
        await lockVenueContentMutation(transaction, { tenantId, venueId: input.venueId })
        const existingPackage = await transaction.venuePackage.findFirst({
          where: key,
          select: venuePackageSelect,
        })
        if (existingPackage) {
          if (existingPackage.payloadHash !== requestedPayloadHash) {
            conflict('Draft key was already used for different venue-package content')
          }
          return {
            kind: 'complete' as const,
            pkg: existingPackage,
            preview: parseStoredPreview(existingPackage),
            replayed: true,
          }
        }

        const preview = await buildPreview(
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
          scanPlaces: input.payload.places.length > 0,
          scanKnowledgeEntries: input.payload.knowledgeEntries.length > 0,
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
              createdBy: ctx.session.userId,
            },
            select: venuePackageSelect,
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
              createdBy: ctx.session.userId,
              completedAt: new Date(),
            },
          })
          await writeAuditLogStrict(
            {
              tenantId,
              actorId: ctx.session.userId,
              actorRole: ctx.session.role ?? 'MANAGER',
              action: 'venue-package.created-draft',
              targetType: 'VenuePackage',
              targetId: pkg.id,
              afterState: auditState(pkg),
            },
            transaction as DbClient,
          )
          return { kind: 'complete' as const, pkg, preview: finalPreview, replayed: false }
        }

        const analysis = await transaction.venuePackageDuplicateAnalysis.create({
          data: {
            ...key,
            payloadHash: preview.payloadHash,
            baseDigest: preview.baseDigest,
            claimToken,
            embeddingProfiles: jsonValue(VENUE_PACKAGE_SEMANTIC_PROFILES),
            similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
            createdBy: ctx.session.userId,
          },
          select: { id: true },
        })
        return { kind: 'claimed' as const, analysisId: analysis.id, preview }
      })

      if (prepared.kind === 'complete') {
        return { ...prepared.pkg, preview: prepared.preview, replayed: prepared.replayed }
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
        db: ctx.db,
        tenantId,
        venueId: input.venueId,
        feature: 'venue-package-duplicate-analysis',
        surface: 'client-dashboard',
      })

      const settleFailure = async (status: 'FAILED' | 'STALE', errorCode: string) => {
        try {
          await ctx.db.venuePackageDuplicateAnalysis.updateMany({
            where: {
              id: prepared.analysisId,
              tenantId,
              venueId: input.venueId,
              status: 'RUNNING',
              claimToken,
            },
            data: {
              status,
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
            terminalStatus: status,
            error: 'Duplicate-analysis settlement failed',
          })
        }
      }

      let candidates
      try {
        candidates = await generateVenuePackageCandidateEmbeddings({
          payload: input.payload,
          usageSink: usage.sink,
          shouldAbort: usage.persistenceFailed,
        })
        if (usage.persistenceFailed()) {
          await settleFailure('FAILED', 'usage-persistence-failed')
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
            ? error.code
            : 'unexpected-error'
        await settleFailure('FAILED', errorCode)
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Duplicate analysis could not complete; no draft was saved.',
        })
      }

      try {
        const finalized = await ctx.db.$transaction(async (transaction) => {
          await lockVenueContentMutation(transaction, { tenantId, venueId: input.venueId })
          const preview = await buildPreview(
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
            scanPlaces: input.payload.places.length > 0,
            scanKnowledgeEntries: input.payload.knowledgeEntries.length > 0,
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
              createdBy: ctx.session.userId,
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
          await writeAuditLogStrict(
            {
              tenantId,
              actorId: ctx.session.userId,
              actorRole: ctx.session.role ?? 'MANAGER',
              action: 'venue-package.created-draft',
              targetType: 'VenuePackage',
              targetId: pkg.id,
              afterState: auditState(pkg),
            },
            transaction as DbClient,
          )
          return { kind: 'complete' as const, pkg, preview: finalPreview }
        })
        if (finalized.kind === 'stale') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Venue content or embedding coverage changed during analysis; use a new key.',
          })
        }
        return { ...finalized.pkg, preview: finalized.preview, replayed: false }
      } catch (error) {
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
        await settleFailure('FAILED', 'finalization-failed')
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Duplicate analysis could not be finalized; no draft was saved.',
        })
      }
    }),

  approve: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageApprovalInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: existing.venueId })
      existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      if (existing.status !== 'DRAFT') {
        if (existing.approvedCommandKey === input.commandKey) return existing
        conflict('Only a draft venue package can be approved')
      }
      const payload = parsePayload(existing.payload)
      const deterministic = await buildPreview(ctx.db, tenantId, existing.venueId, payload)
      const stored = parseStoredPreview(existing)
      assertStoredEvidenceCurrent({ stored, deterministic })
      if (
        stored.report.errors.length > 0 ||
        stored.report.semanticDuplicateScan.status !== 'COMPLETE'
      ) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This draft does not contain a complete semantic scan; save a new draft.',
        })
      }
      if (stored.payloadHash !== input.acknowledgedPayloadHash) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The acknowledged venue-package payload does not match this immutable draft',
        })
      }
      if (stored.warningDigest !== input.acknowledgedWarningDigest) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Review and acknowledge the current venue-package warnings before approval',
        })
      }

      const now = new Date()
      const changed = await ctx.db.venuePackage.updateMany({
        where: {
          id: input.id,
          tenantId,
          status: 'DRAFT',
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          status: 'APPROVED',
          approvedBy: ctx.session.userId,
          approvedAt: now,
          approvedCommandKey: input.commandKey,
          approvalWarningDigest: stored.warningDigest,
          approvedWarningCodes: jsonValue(
            [...new Set(stored.report.warnings.map((warning) => warning.code))].sort(),
          ),
        },
      })
      if (changed.count !== 1) conflict()
      const approved = await findPackage(ctx.db, tenantId, input.id)
      if (!approved) conflict()
      await writeAuditLogStrict(
        {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role ?? 'MANAGER',
          action: 'venue-package.approved',
          targetType: 'VenuePackage',
          targetId: input.id,
          beforeState: auditState(existing),
          afterState: auditState(approved),
        },
        ctx.db,
      )
      return approved
    }),

  applyPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: existing.venueId })
      existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      if (existing.status !== 'APPROVED') {
        if (existing.appliedCommandKey === input.commandKey) return existing
        conflict('Only an approved venue package can be applied')
      }
      const payload = parsePayload(existing.payload)
      const deterministic = await buildPreview(ctx.db, tenantId, existing.venueId, payload)
      const stored = parseStoredPreview(existing)
      assertStoredEvidenceCurrent({ stored, deterministic })
      if (
        stored.report.errors.length > 0 ||
        stored.report.semanticDuplicateScan.status !== 'COMPLETE'
      ) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This package does not contain a complete semantic scan.',
        })
      }

      try {
        const places =
          payload.places.length === 0
            ? []
            : await ctx.db.place.createManyAndReturn({
                data: payload.places.map((place) => ({
                  tenantId,
                  venueId: existing.venueId,
                  name: place.name,
                  type: place.type,
                  ...(place.itemType !== undefined ? { itemType: place.itemType } : {}),
                  ...(place.shortDescription !== undefined
                    ? { shortDescription: place.shortDescription }
                    : {}),
                  ...(place.longDescription !== undefined
                    ? { longDescription: place.longDescription }
                    : {}),
                  ...(place.lat !== undefined ? { lat: place.lat } : {}),
                  ...(place.lng !== undefined ? { lng: place.lng } : {}),
                  tags: place.tags,
                  importanceScore: place.importanceScore,
                  ...(place.areaName !== undefined ? { areaName: place.areaName } : {}),
                  ...(place.hours !== undefined ? { hours: place.hours } : {}),
                  ...(place.photoUrl !== undefined ? { photoUrl: place.photoUrl } : {}),
                })),
                select: {
                  id: true,
                  name: true,
                  type: true,
                  itemType: true,
                  shortDescription: true,
                  longDescription: true,
                  lat: true,
                  lng: true,
                  tags: true,
                  importanceScore: true,
                  areaName: true,
                  hours: true,
                  photoUrl: true,
                },
              })
        const knowledgeEntries =
          payload.knowledgeEntries.length === 0
            ? []
            : await ctx.db.venueKnowledgeEntry.createManyAndReturn({
                data: payload.knowledgeEntries.map((entry) => ({
                  tenantId,
                  venueId: existing.venueId,
                  title: entry.title,
                  category: entry.category,
                  content: entry.content,
                  isEnabled: entry.isEnabled,
                })),
                select: { id: true, title: true, category: true, content: true, isEnabled: true },
              })
        const appliedEntities = VenuePackageAppliedEntities.parse({
          postApplyDigest: await contentStateDigest(ctx.db, tenantId, existing.venueId),
          places,
          knowledgeEntries,
        })
        const now = new Date()
        const changed = await ctx.db.venuePackage.updateMany({
          where: {
            id: input.id,
            tenantId,
            status: 'APPROVED',
            updatedAt: input.expectedUpdatedAt,
          },
          data: {
            status: 'APPLIED',
            appliedBy: ctx.session.userId,
            appliedAt: now,
            appliedCommandKey: input.commandKey,
            appliedEntities: jsonValue(appliedEntities),
          },
        })
        if (changed.count !== 1) conflict()
        const applied = await findPackage(ctx.db, tenantId, input.id)
        if (!applied) conflict()
        await writeAuditLogStrict(
          {
            tenantId,
            actorId: ctx.session.userId,
            actorRole: ctx.session.role ?? 'MANAGER',
            action: 'venue-package.applied',
            targetType: 'VenuePackage',
            targetId: input.id,
            beforeState: auditState(existing),
            afterState: auditState(applied),
          },
          ctx.db,
        )
        return applied
      } catch (error) {
        if (
          error instanceof TRPCError ||
          (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
        ) {
          if (error instanceof TRPCError) throw error
          conflict('Venue-package command key was already used')
        }
        throw error
      }
    }),

  revertPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: existing.venueId })
      existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      if (existing.status !== 'APPLIED') {
        if (existing.revertedCommandKey === input.commandKey) return existing
        conflict('Only an applied venue package can be reverted')
      }
      const manifestResult = VenuePackageAppliedEntities.safeParse(existing.appliedEntities)
      if (!manifestResult.success) conflict('Venue package rollback manifest is invalid')
      const manifest = manifestResult.data
      const current = await contentState(ctx.db, tenantId, existing.venueId)
      if (digest(current) !== manifest.postApplyDigest) {
        conflict('Venue content changed after apply; automatic package rollback is unsafe')
      }

      const currentPlaces = new Map(current.places.map((place) => [place.id, place]))
      const currentKnowledge = new Map(current.knowledgeEntries.map((entry) => [entry.id, entry]))
      if (
        manifest.places.some((place) => {
          const row = currentPlaces.get(place.id)
          return !row || !matchesPlace(row, place)
        }) ||
        manifest.knowledgeEntries.some((entry) => {
          const row = currentKnowledge.get(entry.id)
          return !row || !matchesKnowledge(row, entry)
        })
      ) {
        conflict('Applied package content changed; automatic rollback is unsafe')
      }

      const removedKnowledge = await ctx.db.venueKnowledgeEntry.deleteMany({
        where: {
          tenantId,
          venueId: existing.venueId,
          id: { in: manifest.knowledgeEntries.map((entry) => entry.id) },
        },
      })
      if (removedKnowledge.count !== manifest.knowledgeEntries.length) conflict()
      const removedPlaces = await ctx.db.place.deleteMany({
        where: {
          tenantId,
          venueId: existing.venueId,
          id: { in: manifest.places.map((place) => place.id) },
        },
      })
      if (removedPlaces.count !== manifest.places.length) conflict()
      if ((await contentStateDigest(ctx.db, tenantId, existing.venueId)) !== existing.baseDigest) {
        conflict('Venue package rollback did not restore the approved base state')
      }

      const now = new Date()
      const changed = await ctx.db.venuePackage.updateMany({
        where: {
          id: input.id,
          tenantId,
          status: 'APPLIED',
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          status: 'REVERTED',
          revertedBy: ctx.session.userId,
          revertedAt: now,
          revertedCommandKey: input.commandKey,
        },
      })
      if (changed.count !== 1) conflict()
      const reverted = await findPackage(ctx.db, tenantId, input.id)
      if (!reverted) conflict()
      await writeAuditLogStrict(
        {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role ?? 'MANAGER',
          action: 'venue-package.reverted',
          targetType: 'VenuePackage',
          targetId: input.id,
          beforeState: auditState(existing),
          afterState: auditState(reverted),
        },
        ctx.db,
      )
      return reverted
    }),
})

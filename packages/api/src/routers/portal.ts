import { resolveClientPortalLifecycle } from '@pathfinder/contracts/client-portal-lifecycle'
import { CreateClientPreviewFeedbackInput } from '@pathfinder/contracts/client-package-preview'
import { createPreviewFeedbackRequestAction, SupportActionError } from '@pathfinder/db'
import { z } from 'zod'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { tenantProcedure } from '../trpc'
import { VenuePackagePayload } from '../schemas/venue-package'
import {
  ClientPackagePreviewProjectionError,
  canonicalVenuePackageWarningCodes,
  clientPackagePreviewProjection,
} from '../lib/client-package-preview'
import {
  assertStoredVenuePackageEvidenceCurrent,
  buildVenuePackagePreview,
  parseStoredVenuePackagePreview,
  VenuePackageApprovedBaseStaleError,
} from './venue-package'
import { TRPCError } from '@trpc/server'

type CountRow = { venueId: string; status: string; _count: { _all: number } }

function countsByVenue(rows: CountRow[]): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const venue = result.get(row.venueId) ?? new Map<string, number>()
    venue.set(row.status, row._count._all)
    result.set(row.venueId, venue)
  }
  return result
}

function total(statuses: Map<string, number> | undefined, names: readonly string[]): number {
  return names.reduce((sum, status) => sum + (statuses?.get(status) ?? 0), 0)
}

type PortalDb = Parameters<Parameters<typeof import('@pathfinder/db').db.$transaction>[0]>[0]

async function loadClientPreview(
  db: PortalDb,
  tenantId: string,
  input: { venueId: string; packageId: string },
) {
  const pkg = await db.venuePackage.findFirst({
    where: { id: input.packageId, tenantId, venueId: input.venueId, status: 'APPROVED' },
    select: {
      id: true,
      venueId: true,
      schemaVersion: true,
      payload: true,
      payloadHash: true,
      baseDigest: true,
      validationReport: true,
      previewPlan: true,
      approvedAt: true,
      approvedBy: true,
      approvedCommandKey: true,
      approvalWarningDigest: true,
      approvedWarningCodes: true,
    },
  })
  if (!pkg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Approved client preview not found' })
  if (!pkg.approvedAt || !pkg.approvedBy || !pkg.approvedCommandKey || !pkg.approvalWarningDigest) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Approved preview evidence is incomplete',
    })
  }
  const venue = await db.venue.findFirst({
    where: { id: input.venueId, tenantId },
    select: {
      id: true,
      name: true,
      description: true,
      category: true,
      chatTheme: true,
      chatAccentColor: true,
      chatFont: true,
      chatLogoUrl: true,
      chatBannerUrl: true,
      aiGuideName: true,
      aiTone: true,
      tonePreset: true,
      tonePresetVersion: true,
      places: {
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: 501,
        select: {
          id: true,
          name: true,
          type: true,
          shortDescription: true,
          longDescription: true,
          areaName: true,
          hours: true,
          photoUrl: true,
          lat: true,
          lng: true,
          tags: true,
          isActive: true,
        },
      },
      knowledgeEntries: {
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        take: 501,
        select: { id: true, title: true, category: true, content: true, isEnabled: true },
      },
    },
  })
  if (!venue)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Approved client preview not found' })
  if (venue.places.length > 500 || venue.knowledgeEntries.length > 500)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Approved preview exceeds safe client limits',
    })
  const payload = VenuePackagePayload.safeParse(pkg.payload)
  if (!payload.success)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Approved package payload is invalid',
    })
  let stored: ReturnType<typeof parseStoredVenuePackagePreview>
  try {
    stored = parseStoredVenuePackagePreview(pkg)
  } catch (error) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Approved preview evidence is invalid',
      cause: error,
    })
  }
  if (
    stored.report.errors.length > 0 ||
    stored.report.semanticDuplicateScan.status !== 'COMPLETE' ||
    stored.warningDigest !== pkg.approvalWarningDigest ||
    JSON.stringify(canonicalVenuePackageWarningCodes(stored.report.warnings)) !==
      JSON.stringify(
        Array.isArray(pkg.approvedWarningCodes)
          ? pkg.approvedWarningCodes
              .filter((code): code is string => typeof code === 'string')
              .sort()
          : [],
      )
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Approved preview evidence no longer satisfies review requirements',
    })
  }
  const deterministic = await buildVenuePackagePreview(
    db as TRPCContext['db'],
    tenantId,
    input.venueId,
    payload.data,
  )
  try {
    assertStoredVenuePackageEvidenceCurrent({ stored, deterministic })
  } catch (error) {
    if (error instanceof VenuePackageApprovedBaseStaleError) throw error
    if (error instanceof TRPCError && error.code === 'CONFLICT')
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Approved preview evidence is inconsistent',
        cause: error,
      })
    throw error
  }
  try {
    return clientPackagePreviewProjection({
      venue: {
        id: venue.id,
        name: venue.name,
        description: venue.description,
        category: venue.category,
        chatTheme: venue.chatTheme,
        chatAccentColor: venue.chatAccentColor,
        chatFont: venue.chatFont,
        chatLogoUrl: venue.chatLogoUrl,
        chatBannerUrl: venue.chatBannerUrl,
        aiGuideName: venue.aiGuideName,
        aiTone: venue.aiTone,
        tonePreset: venue.tonePreset,
        tonePresetVersion: venue.tonePresetVersion,
      },
      places: venue.places,
      knowledgeEntries: venue.knowledgeEntries,
      pkg: { id: pkg.id, approvedAt: pkg.approvedAt },
      stored,
    })
  } catch (error) {
    if (error instanceof ClientPackagePreviewProjectionError)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error })
    throw error
  }
}

function mapSupportActionError(error: unknown): never {
  if (!(error instanceof SupportActionError)) throw error
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

function serializeFeedbackResult<
  T extends {
    request: {
      id: string
      venueId: string
      category: string
      status: string
      subject: string
      missingInformation: unknown
      clientVersion: number
      clientActivityAt: Date
      statusChangedAt: Date
      createdAt: Date
    }
    message: {
      id: string
      authorKind: string
      visibility: string
      body: string
      createdAt: Date
      attachments: Array<{
        id: string
        filename: string
        mediaType: string
        byteSize: bigint
        createdAt: Date
      }>
    }
    feedback: object
    replayed: boolean
  },
>(result: T) {
  return {
    request: {
      id: result.request.id,
      venueId: result.request.venueId,
      category: result.request.category,
      status: result.request.status,
      subject: result.request.subject,
      missingInformation: result.request.missingInformation,
      clientVersion: result.request.clientVersion,
      clientActivityAt: result.request.clientActivityAt,
      statusChangedAt: result.request.statusChangedAt,
      createdAt: result.request.createdAt,
      requesterIsCurrentUser: true,
      participantIsCurrentUser: false,
      canReply: result.request.status !== 'COMPLETED' && result.request.status !== 'CANCELLED',
    },
    message: {
      id: result.message.id,
      authorKind: result.message.authorKind,
      visibility: result.message.visibility,
      body: result.message.body,
      createdAt: result.message.createdAt,
      attachments: result.message.attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        byteSize: attachment.byteSize.toString(),
        createdAt: attachment.createdAt,
      })),
    },
    feedback: result.feedback,
    replayed: result.replayed,
  }
}

export function clientPreviewLifecycleFailureState(error: unknown): 'SUPERSEDED' | 'UNAVAILABLE' {
  if (error instanceof VenuePackageApprovedBaseStaleError) return 'SUPERSEDED'
  if (error instanceof TRPCError && error.code === 'PRECONDITION_FAILED') return 'UNAVAILABLE'
  throw error
}

export const portalRouter = router({
  getVenueLifecycles: tenantProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.session.activeTenantId
    return ctx.db.$transaction(
      async (db) => {
        const venues = await db.venue.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            isActive: true,
            _count: {
              select: {
                places: { where: { isActive: true } },
                knowledgeEntries: { where: { isEnabled: true } },
              },
            },
          },
          take: 501,
        })
        if (venues.length > 500)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Client portal lifecycle exceeds safe tenant limits',
          })
        const venueIds = venues.map(({ id }) => id)
        const [
          intakeRows,
          mediaRows,
          packageRows,
          previouslyActive,
          offboardingTargets,
          approvedPreviews,
        ] = await Promise.all([
          db.intakeRun.groupBy({
            by: ['venueId', 'status'],
            where: { tenantId, venueId: { in: venueIds } },
            _count: { _all: true },
          }),
          db.mediaIngestionProject.groupBy({
            by: ['venueId', 'status'],
            where: { tenantId, venueId: { in: venueIds } },
            _count: { _all: true },
          }),
          db.venuePackage.groupBy({
            by: ['venueId', 'status'],
            where: { tenantId, venueId: { in: venueIds } },
            _count: { _all: true },
          }),
          db.contentVersion.findMany({
            where: {
              tenantId,
              venueId: { in: venueIds },
              entityType: 'VENUE',
              afterState: { path: ['isActive'], equals: true },
            },
            select: { venueId: true },
            distinct: ['venueId'],
            take: 501,
          }),
          db.offboardingVenueTarget.findMany({
            where: {
              tenantId,
              venueId: { in: venueIds },
              plan: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
            },
            select: { venueId: true },
            distinct: ['venueId'],
            take: 501,
          }),
          db.venuePackage.findMany({
            where: {
              tenantId,
              venueId: { in: venueIds },
              status: 'APPROVED',
              approvedAt: { not: null },
            },
            orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
            distinct: ['venueId'],
            select: { id: true, venueId: true },
            take: 501,
          }),
        ])

        if (
          previouslyActive.length > 500 ||
          offboardingTargets.length > 500 ||
          approvedPreviews.length > 500
        )
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Client portal lifecycle exceeds safe tenant limits',
          })

        const intake = countsByVenue(intakeRows)
        const media = countsByVenue(mediaRows)
        const packages = countsByVenue(packageRows)
        const activeHistory = new Set(previouslyActive.map(({ venueId }) => venueId))
        const offboarding = new Set(offboardingTargets.map(({ venueId }) => venueId))
        const previewAvailability = new Map<
          string,
          { state: 'AVAILABLE' | 'SUPERSEDED' | 'UNAVAILABLE'; id: string | null }
        >()
        for (const candidate of approvedPreviews) {
          try {
            await loadClientPreview(db, tenantId, {
              venueId: candidate.venueId,
              packageId: candidate.id,
            })
            previewAvailability.set(candidate.venueId, { state: 'AVAILABLE', id: candidate.id })
          } catch (error) {
            previewAvailability.set(candidate.venueId, {
              state: clientPreviewLifecycleFailureState(error),
              id: null,
            })
          }
        }

        return venues.map((venue) => {
          const mediaStatuses = media.get(venue.id)
          const packageStatuses = packages.get(venue.id)
          const packageCounts = {
            draft: packageStatuses?.get('DRAFT') ?? 0,
            approved: packageStatuses?.get('APPROVED') ?? 0,
            applied: packageStatuses?.get('APPLIED') ?? 0,
            reverted: packageStatuses?.get('REVERTED') ?? 0,
          }
          const publicContentCount = venue._count.places + venue._count.knowledgeEntries
          const lifecycle = resolveClientPortalLifecycle({
            isActive: venue.isActive,
            publicContentCount,
            wasLive:
              activeHistory.has(venue.id) && (publicContentCount > 0 || packageCounts.applied > 0),
            collectingSourceCount: total(mediaStatuses, ['DRAFT', 'UPLOADING', 'NEEDS_INPUT']),
            processingSourceCount: total(mediaStatuses, [
              'QUEUED',
              'INVENTORYING',
              'ANALYZING',
              'SYNTHESIZING',
            ]),
            reviewSourceCount: total(mediaStatuses, ['READY_FOR_REVIEW', 'COMPLETE']),
            intakeProposalCount: total(intake.get(venue.id), ['AWAITING_REVIEW']),
            packageCounts,
            hasActiveOffboarding: offboarding.has(venue.id),
          })
          return {
            venueId: venue.id,
            venueName: venue.name,
            lifecycle,
            clientPreview:
              lifecycle.state === 'CLIENT_PREVIEW'
                ? (previewAvailability.get(venue.id) ?? { state: 'UNAVAILABLE', id: null })
                : { state: 'UNAVAILABLE' as const, id: null },
          }
        })
      },
      { isolationLevel: 'RepeatableRead' },
    )
  }),

  getClientPreview: tenantProcedure
    .input(
      z
        .object({ venueId: z.string().min(1).max(191), packageId: z.string().min(1).max(191) })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      return ctx.db.$transaction((db) => loadClientPreview(db, tenantId, input), {
        isolationLevel: 'RepeatableRead',
      })
    }),
  createPreviewFeedbackRequest: tenantProcedure
    .input(CreateClientPreviewFeedbackInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      try {
        const result = await createPreviewFeedbackRequestAction(
          {
            ...input,
            tenantId,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'CLIENT',
              actorId: ctx.session.userId,
              auditRole: ctx.session.role ?? 'STAFF',
            },
          },
          {
            assertEligible: async (tx, scope) => {
              await loadClientPreview(tx, scope.tenantId, {
                venueId: scope.venueId,
                packageId: scope.packageId,
              })
            },
          },
          ctx.db,
        )
        return serializeFeedbackResult(result)
      } catch (error) {
        mapSupportActionError(error)
      }
    }),
})

import { TRPCError } from '@trpc/server'

import type { TRPCContext } from '../context'
import {
  ClientPackagePreviewProjectionError,
  reviewableVenuePackageEvaluationPreviewProjection,
} from './client-package-preview'
import { VenuePackagePayload } from '../schemas/venue-package'
import {
  assertStoredVenuePackageEvidenceCurrent,
  buildVenuePackagePreview,
  parseStoredVenuePackagePreview,
  VenuePackageApprovedBaseStaleError,
} from '../routers/venue-package'

type PackageDb = Parameters<Parameters<typeof import('@pathfinder/db').db.$transaction>[0]>[0]

export async function loadReviewableVenuePackageEvaluationPreview(
  db: PackageDb,
  tenantId: string,
  input: { venueId: string; packageId: string },
  options: { publicAudienceOnly?: boolean } = {},
) {
  const pkg = await db.venuePackage.findFirst({
    where: {
      id: input.packageId,
      tenantId,
      venueId: input.venueId,
      status: { in: ['DRAFT', 'APPROVED'] },
    },
    select: {
      id: true,
      venueId: true,
      schemaVersion: true,
      payload: true,
      payloadHash: true,
      baseDigest: true,
      validationReport: true,
      previewPlan: true,
      status: true,
      createdAt: true,
      approvedAt: true,
    },
  })
  if (!pkg)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Reviewable venue package not found' })

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
          visibility: true,
        },
      },
      knowledgeEntries: {
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        take: 501,
        select: {
          id: true,
          title: true,
          category: true,
          content: true,
          isEnabled: true,
          visibility: true,
        },
      },
    },
  })
  if (!venue)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Reviewable venue package not found' })
  if (venue.places.length > 500 || venue.knowledgeEntries.length > 500)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Reviewable package preview exceeds safe evaluation limits',
    })

  const payload = VenuePackagePayload.safeParse(pkg.payload)
  if (!payload.success)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Reviewable package payload is invalid',
    })
  let stored: ReturnType<typeof parseStoredVenuePackagePreview>
  try {
    stored = parseStoredVenuePackagePreview(pkg)
  } catch (error) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Reviewable package evidence is invalid',
      cause: error,
    })
  }
  if (stored.report.errors.length > 0 || stored.report.semanticDuplicateScan.status !== 'COMPLETE')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Reviewable package requires error-free validation and complete semantic evidence',
    })

  const deterministic = await buildVenuePackagePreview(
    db as TRPCContext['db'],
    tenantId,
    input.venueId,
    payload.data,
  )
  try {
    assertStoredVenuePackageEvidenceCurrent({ stored, deterministic })
  } catch (error) {
    if (error instanceof VenuePackageApprovedBaseStaleError)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Reviewable package base content changed; create a fresh package draft',
        cause: error,
      })
    throw error
  }

  // A guest-facing preview must never carry employee-only (second layer) content: drop those rows
  // from the base and drop any package change that names one, before anything is projected.
  const publicOnly = options.publicAudienceOnly === true
  const hiddenPlaceIds = new Set(
    venue.places.filter((row) => row.visibility !== 'PUBLIC').map((row) => row.id),
  )
  const hiddenKnowledgeIds = new Set(
    venue.knowledgeEntries.filter((row) => row.visibility !== 'PUBLIC').map((row) => row.id),
  )
  const projectionStored =
    publicOnly && stored.schemaVersion === 3
      ? {
          ...stored,
          changes: {
            ...stored.changes,
            places: {
              ...stored.changes.places,
              change: stored.changes.places.change.filter(({ id }) => !hiddenPlaceIds.has(id)),
              remove: stored.changes.places.remove.filter(({ id }) => !hiddenPlaceIds.has(id)),
            },
            knowledgeEntries: {
              ...stored.changes.knowledgeEntries,
              change: stored.changes.knowledgeEntries.change.filter(
                ({ id }) => !hiddenKnowledgeIds.has(id),
              ),
              remove: stored.changes.knowledgeEntries.remove.filter(
                ({ id }) => !hiddenKnowledgeIds.has(id),
              ),
            },
          },
        }
      : stored
  try {
    const status = pkg.status === 'DRAFT' ? 'DRAFT' : 'APPROVED'
    return {
      package: {
        id: pkg.id,
        status,
        payloadHash: pkg.payloadHash,
        baseDigest: pkg.baseDigest,
        evidenceAt: pkg.approvedAt ?? pkg.createdAt,
      },
      preview: reviewableVenuePackageEvaluationPreviewProjection({
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
        places: publicOnly
          ? venue.places.filter((row) => row.visibility === 'PUBLIC')
          : venue.places,
        knowledgeEntries: publicOnly
          ? venue.knowledgeEntries.filter((row) => row.visibility === 'PUBLIC')
          : venue.knowledgeEntries,
        pkg: { id: pkg.id, status, evidenceAt: pkg.approvedAt ?? pkg.createdAt },
        stored: projectionStored,
      }),
    }
  } catch (error) {
    if (error instanceof ClientPackagePreviewProjectionError)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error })
    throw error
  }
}

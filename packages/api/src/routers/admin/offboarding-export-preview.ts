import { TRPCError } from '@trpc/server'

import {
  OffboardingExportManifestPreview,
  OffboardingExportPreviewInput,
} from '@pathfinder/contracts/offboarding-export-preview'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const caps = {
  places: 500,
  knowledgeEntries: 500,
  contentHistory: 1_000,
  packages: 250,
  modules: 500,
  revisions: 1_000,
  evidence: 1_000,
} as const

function truncation(returned: number, available: number, cap: number) {
  return { returned, available, cap, truncated: available > returned }
}

export const adminOffboardingExportPreviewRouter = router({
  previewOffboardingExportManifest: adminProcedure
    .input(OffboardingExportPreviewInput)
    .output(OffboardingExportManifestPreview)
    .query(async ({ ctx, input }) => {
      const scope = { tenantId: input.tenantId, venueId: { in: input.venueIds } }
      const venues = await ctx.db.venue.findMany({
        where: { tenantId: input.tenantId, id: { in: input.venueIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          isActive: true,
          tonePreset: true,
          tonePresetVersion: true,
          updatedAt: true,
        },
      })
      if (venues.length !== input.venueIds.length) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'One or more venues were not found' })
      }

      const [
        places,
        placeCount,
        knowledge,
        knowledgeCount,
        history,
        historyCount,
        packages,
        packageCount,
        modules,
        moduleCount,
        revisions,
        revisionCount,
        evidence,
        evidenceCount,
      ] = await Promise.all([
        ctx.db.place.findMany({
          where: { ...scope, isActive: true },
          orderBy: [{ venueId: 'asc' }, { id: 'asc' }],
          take: caps.places,
          select: { id: true, venueId: true, sourcePackageId: true, updatedAt: true },
        }),
        ctx.db.place.count({ where: { ...scope, isActive: true } }),
        ctx.db.venueKnowledgeEntry.findMany({
          where: { ...scope, isEnabled: true },
          orderBy: [{ venueId: 'asc' }, { id: 'asc' }],
          take: caps.knowledgeEntries,
          select: { id: true, venueId: true, sourcePackageId: true, updatedAt: true },
        }),
        ctx.db.venueKnowledgeEntry.count({ where: { ...scope, isEnabled: true } }),
        ctx.db.contentVersion.findMany({
          where: scope,
          orderBy: [{ sequence: 'asc' }],
          take: caps.contentHistory,
          select: {
            id: true,
            venueId: true,
            sequence: true,
            entityType: true,
            entityId: true,
            operation: true,
            venuePackageId: true,
            venuePackageAction: true,
            snapshotSchemaVersion: true,
            createdAt: true,
          },
        }),
        ctx.db.contentVersion.count({ where: scope }),
        ctx.db.venuePackage.findMany({
          where: scope,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: caps.packages,
          select: {
            id: true,
            venueId: true,
            schemaVersion: true,
            payloadHash: true,
            baseDigest: true,
            status: true,
            createdAt: true,
            approvedAt: true,
            appliedAt: true,
            revertedAt: true,
          },
        }),
        ctx.db.venuePackage.count({ where: scope }),
        ctx.db.contentModuleIdentity.findMany({
          where: { ...scope, revisions: { some: { audience: { in: ['PUBLIC', 'CLIENT'] } } } },
          orderBy: [{ venueId: 'asc' }, { id: 'asc' }],
          take: caps.modules,
          select: { id: true, venueId: true, kind: true, createdAt: true },
        }),
        ctx.db.contentModuleIdentity.count({
          where: { ...scope, revisions: { some: { audience: { in: ['PUBLIC', 'CLIENT'] } } } },
        }),
        ctx.db.contentModuleRevision.findMany({
          where: { ...scope, audience: { in: ['PUBLIC', 'CLIENT'] } },
          orderBy: [{ venueId: 'asc' }, { moduleId: 'asc' }, { version: 'asc' }],
          take: caps.revisions,
          select: {
            id: true,
            venueId: true,
            moduleId: true,
            kind: true,
            version: true,
            audience: true,
            effectiveFrom: true,
            effectiveUntil: true,
            createdAt: true,
          },
        }),
        ctx.db.contentModuleRevision.count({
          where: { ...scope, audience: { in: ['PUBLIC', 'CLIENT'] } },
        }),
        ctx.db.contentModuleEvidence.findMany({
          where: { ...scope, revision: { audience: { in: ['PUBLIC', 'CLIENT'] } } },
          orderBy: [{ venueId: 'asc' }, { revisionId: 'asc' }, { id: 'asc' }],
          take: caps.evidence,
          select: {
            id: true,
            venueId: true,
            revisionId: true,
            moduleKind: true,
            excerptHash: true,
            capturedAt: true,
          },
        }),
        ctx.db.contentModuleEvidence.count({
          where: { ...scope, revision: { audience: { in: ['PUBLIC', 'CLIENT'] } } },
        }),
      ])

      const currentContent = [
        ...places.map((item) => ({ ...item, kind: 'PLACE' as const })),
        ...knowledge.map((item) => ({ ...item, kind: 'KNOWLEDGE_ENTRY' as const })),
      ]
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        tenantId: input.tenantId,
        selectedVenueIds: [...input.venueIds].sort(),
        privacyBoundary: 'METADATA_REFERENCES_ONLY',
        venues: venues.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString() })),
        currentContent: currentContent.map((item) => ({
          ...item,
          updatedAt: item.updatedAt.toISOString(),
        })),
        contentHistory: history.map((item) => ({
          ...item,
          sequence: item.sequence.toString(),
          createdAt: item.createdAt.toISOString(),
        })),
        packages: packages.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          approvedAt: item.approvedAt?.toISOString() ?? null,
          appliedAt: item.appliedAt?.toISOString() ?? null,
          revertedAt: item.revertedAt?.toISOString() ?? null,
        })),
        modules: modules.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
        revisions: revisions.map((item) => ({
          ...item,
          effectiveFrom: item.effectiveFrom?.toISOString() ?? null,
          effectiveUntil: item.effectiveUntil?.toISOString() ?? null,
          createdAt: item.createdAt.toISOString(),
        })),
        evidence: evidence.map((item) => ({ ...item, capturedAt: item.capturedAt.toISOString() })),
        truncation: {
          places: truncation(places.length, placeCount, caps.places),
          knowledgeEntries: truncation(knowledge.length, knowledgeCount, caps.knowledgeEntries),
          contentHistory: truncation(history.length, historyCount, caps.contentHistory),
          packages: truncation(packages.length, packageCount, caps.packages),
          modules: truncation(modules.length, moduleCount, caps.modules),
          revisions: truncation(revisions.length, revisionCount, caps.revisions),
          evidence: truncation(evidence.length, evidenceCount, caps.evidence),
        },
      }
    }),
})

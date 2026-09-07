import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import {
  db,
  publishUniversalContentAction,
  withdrawUniversalContentAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { retrieveGuestKnowledge } from './guest-knowledge-retrieval'
import { legacyKnowledgeSnapshotHash } from './legacy-knowledge-adoption'
import { createLegacyKnowledgeAdoptionDraftService } from './legacy-knowledge-adoption-service'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

const enabled =
  process.env.RUN_LEGACY_KNOWLEDGE_ADOPTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('legacy knowledge adoption on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('keeps legacy public through draft, switches once on publish, and never resurrects after withdraw', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `adoption-${suffix}`
      const venueId = `museum-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: `owner-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Adoption fixture' } })
      await db.venue.create({
        data: { id: venueId, tenantId, slug: venueId, name: 'Adoption museum' },
      })
      const legacy = await db.venueKnowledgeEntry.create({
        data: {
          id: `legacy-${suffix}`,
          tenantId,
          venueId,
          title: 'Gallery capacity',
          category: 'POLICY',
          content: 'The gallery capacity was 120.',
          isEnabled: true,
          visibility: 'PUBLIC',
          sourceType: 'UNKNOWN',
          authorship: 'UNKNOWN',
          sourceName: 'Opening workbook',
        },
      })
      const proposal = await db.knowledgeChangeProposal.create({
        data: {
          tenantId,
          venueId,
          targetKnowledgeEntryId: legacy.id,
          proposedChange: 'Capacity is now 137.',
          reason: 'Approved current measurement.',
          confidence: 0.99,
          status: 'APPROVED',
          createdByType: 'OPERATOR',
          createdById: actor.id,
          reviewerId: actor.id,
          reviewedAt: new Date(),
        },
      })
      const desired = {
        title: 'Gallery capacity',
        category: 'POLICY',
        content: 'The gallery capacity is 137.',
        isEnabled: true,
      }
      const preview = await previewSemanticVenueUpdateFromProposal({
        db,
        tenantId,
        venueId,
        proposalId: proposal.id,
        expectedUpdatedAt: proposal.updatedAt,
        relation: 'CORRECTS',
        desired,
      })
      const sourceSnapshot = {
        id: legacy.id,
        title: legacy.title,
        category: legacy.category,
        content: legacy.content,
        isEnabled: legacy.isEnabled,
        visibility: legacy.visibility,
        sourceType: legacy.sourceType,
        authorship: legacy.authorship,
        sourceName: legacy.sourceName,
        sourceUrl: legacy.sourceUrl,
        importedAt: legacy.importedAt?.toISOString() ?? null,
        humanConfirmedAt: legacy.humanConfirmedAt?.toISOString() ?? null,
        humanConfirmedBy: legacy.humanConfirmedBy,
        lastReviewedAt: legacy.lastReviewedAt?.toISOString() ?? null,
        lastReviewedBy: legacy.lastReviewedBy,
        sourcePackageId: legacy.sourcePackageId,
        createdAt: legacy.createdAt.toISOString(),
        updatedAt: legacy.updatedAt.toISOString(),
      }
      const input = {
        tenantId,
        venueId,
        proposalId: proposal.id,
        legacyKnowledgeEntryId: legacy.id,
        expectedProposalUpdatedAt: proposal.updatedAt.toISOString(),
        expectedPreviewHash: preview.previewHash,
        expectedLegacyUpdatedAt: legacy.updatedAt.toISOString(),
        expectedLegacySnapshotHash: legacyKnowledgeSnapshotHash(sourceSnapshot),
        relation: 'CORRECTS' as const,
        desired,
        draft: {
          audience: 'PUBLIC' as const,
          evidence: [
            {
              sourceId: `legacy-knowledge:${legacy.id}`,
              capturedAt: legacy.updatedAt.toISOString(),
            },
          ],
          payload: {
            kind: 'POLICY' as const,
            title: legacy.title,
            rule: desired.content,
            appliesTo: [],
          },
        },
      }
      const race = await Promise.all([
        createLegacyKnowledgeAdoptionDraftService({ db, actor, input }),
        createLegacyKnowledgeAdoptionDraftService({ db, actor, input }),
      ])
      expect(new Set(race.map((item) => item.revisionId)).size).toBe(1)
      expect(race.filter((item) => item.replayed)).toHaveLength(1)
      expect(
        await db.legacyKnowledgeAdoptionActivation.count({ where: { tenantId, venueId } }),
      ).toBe(0)
      await db.$executeRaw`
        UPDATE venue_knowledge_entries
           SET embedding = NULL
         WHERE id = ${legacy.id} AND tenant_id = ${tenantId} AND venue_id = ${venueId}
      `
      await expect(
        db.venueKnowledgeEntry.update({
          where: { id: legacy.id },
          data: { content: 'An unauthorized second authority.' },
        }),
      ).rejects.toThrow(/immutable historical evidence/u)
      await expect(db.venueKnowledgeEntry.delete({ where: { id: legacy.id } })).rejects.toThrow(
        /immutable historical evidence/u,
      )
      expect(
        (
          await retrieveGuestKnowledge({
            reader: db,
            query: 'gallery capacity',
            tenantId,
            venueId,
            includeSecondLayer: false,
            queryEmbedding: null,
          })
        ).entries.map(({ id }) => id),
      ).toContain(legacy.id)

      const adopted = race[0]!
      await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: adopted.moduleId,
        revisionId: adopted.revisionId,
        expectedLatestVersion: 1,
        requestId: randomUUID(),
        actor,
      })
      expect(
        await db.legacyKnowledgeAdoptionActivation.count({ where: { tenantId, venueId } }),
      ).toBe(1)
      await expect(
        db.legacyKnowledgeAdoptionActivation.deleteMany({ where: { tenantId, venueId } }),
      ).rejects.toThrow(/append-only/iu)
      const afterPublish = await retrieveGuestKnowledge({
        reader: db,
        query: 'gallery capacity',
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: null,
      })
      expect(afterPublish.entries.map(({ id }) => id)).not.toContain(legacy.id)
      expect(afterPublish.entries).toHaveLength(1)

      await withdrawUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: adopted.moduleId,
        expectedPublishedRevisionId: adopted.revisionId,
        requestId: randomUUID(),
        actor,
      })
      const afterWithdraw = await retrieveGuestKnowledge({
        reader: db,
        query: 'gallery capacity',
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: null,
      })
      expect(afterWithdraw.entries.map(({ id }) => id)).not.toContain(legacy.id)
      expect(afterWithdraw.entries).toHaveLength(0)
    })
  })
})

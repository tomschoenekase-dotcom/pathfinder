import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

const enabled =
  process.env.RUN_KNOWLEDGE_PROPOSAL_PACKAGE_HANDOFF_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('knowledge proposal package handoff disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('retains one exact-scope append-only bridge to an inert package draft', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-semantic-handoff-${suffix}`
      const venueId = `venue-semantic-handoff-${suffix}`
      const otherTenantId = `tenant-semantic-handoff-other-${suffix}`
      const otherVenueId = `venue-semantic-handoff-other-${suffix}`
      const previewHash = 'a'.repeat(64)

      await db.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } })
      await db.venue.create({ data: { id: venueId, tenantId, name: venueId, slug: venueId } })
      await db.tenant.create({
        data: { id: otherTenantId, name: otherTenantId, slug: otherTenantId },
      })
      await db.venue.create({
        data: {
          id: otherVenueId,
          tenantId: otherTenantId,
          name: otherVenueId,
          slug: otherVenueId,
        },
      })

      const proposal = await db.knowledgeChangeProposal.create({
        data: {
          tenantId,
          venueId,
          proposedChange: 'Replace the stale entrance direction.',
          reason: 'Reviewed operator evidence identifies the east entrance.',
          confidence: 0.96,
          status: 'APPROVED',
          createdByType: 'OPERATOR',
          createdById: 'semantic-integration-author',
          reviewerId: 'semantic-integration-reviewer',
          reviewedAt: new Date(),
        },
      })
      const venuePackage = await db.venuePackage.create({
        data: {
          tenantId,
          venueId,
          draftKey: randomUUID(),
          schemaVersion: 1,
          payload: { schemaVersion: 1, places: [], knowledgeEntries: [] },
          payloadHash: 'b'.repeat(64),
          baseDigest: 'c'.repeat(64),
          validationReport: {
            errors: [],
            warnings: [],
            semanticDuplicateScan: { status: 'COMPLETE', candidates: [] },
          },
          previewPlan: {
            report: {
              errors: [],
              warnings: [],
              semanticDuplicateScan: { status: 'COMPLETE', candidates: [] },
            },
          },
          status: 'DRAFT',
          createdBy: 'semantic-integration-reviewer',
        },
      })

      const handoff = await db.knowledgeProposalPackageHandoff.create({
        data: {
          tenantId,
          venueId,
          proposalId: proposal.id,
          venuePackageId: venuePackage.id,
          previewHash,
          createdBy: 'semantic-integration-reviewer',
        },
      })

      await expect(
        db.knowledgeProposalPackageHandoff.create({
          data: {
            tenantId,
            venueId,
            proposalId: proposal.id,
            venuePackageId: venuePackage.id,
            previewHash,
            createdBy: 'semantic-integration-reviewer',
          },
        }),
      ).rejects.toThrow()

      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO knowledge_proposal_package_handoffs
             (tenant_id, venue_id, proposal_id, venue_package_id, preview_hash, created_by)
           VALUES ($1, $2, $3::uuid, $4, $5, $6)`,
          otherTenantId,
          otherVenueId,
          proposal.id,
          venuePackage.id,
          previewHash,
          'cross-scope-attempt',
        ),
      ).rejects.toThrow()
      await expect(
        db.$executeRawUnsafe(
          'UPDATE knowledge_proposal_package_handoffs SET created_by = $1 WHERE id = $2::uuid',
          'tampered',
          handoff.id,
        ),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.$executeRawUnsafe(
          'DELETE FROM knowledge_proposal_package_handoffs WHERE id = $1::uuid',
          handoff.id,
        ),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.$executeRawUnsafe('TRUNCATE TABLE knowledge_proposal_package_handoffs'),
      ).rejects.toThrow(/append-only/u)

      expect(
        await db.knowledgeProposalPackageHandoff.findUniqueOrThrow({
          where: { id: handoff.id },
        }),
      ).toMatchObject({
        tenantId,
        venueId,
        proposalId: proposal.id,
        venuePackageId: venuePackage.id,
        previewHash,
      })
      expect(
        await db.venuePackage.findUniqueOrThrow({ where: { id: venuePackage.id } }),
      ).toMatchObject({ status: 'DRAFT', approvedAt: null, appliedAt: null })
    })
  })
})

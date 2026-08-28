import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  applyVenuePackageAction,
  approveVenuePackageAction,
  revertVenuePackageAction,
} from './venue-package-lifecycle-actions'
import {
  expireOperationalUpdateAction,
  scheduleOperationalUpdateAction,
} from './operational-update-actions'

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

  it('retains one exact-scope append-only bridge to an inactive operational DRAFT', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-temporal-handoff-${suffix}`
      const venueId = `venue-temporal-handoff-${suffix}`
      const otherTenantId = `tenant-temporal-other-${suffix}`
      const otherVenueId = `venue-temporal-other-${suffix}`
      const previewHash = 'd'.repeat(64)

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
          proposedChange: 'Retain a temporary atrium closure.',
          reason: 'Reviewed venue evidence includes an exact validity window.',
          confidence: 0.97,
          status: 'APPROVED',
          createdByType: 'OPERATOR',
          createdById: 'temporal-integration-author',
          reviewerId: 'temporal-integration-reviewer',
          reviewedAt: new Date(),
        },
      })
      const update = await db.operationalUpdate.create({
        data: {
          tenantId,
          venueId,
          updateType: 'TEMPORARY_CLOSURE',
          severity: 'INFO',
          priority: 'NORMAL',
          title: 'Atrium closure',
          body: 'Closed for maintenance.',
          startsAt: new Date('2030-01-01T08:00:00.000Z'),
          expiresAt: new Date('2030-01-01T12:00:00.000Z'),
          status: 'DRAFT',
          isActive: false,
          createdBy: 'temporal-integration-reviewer',
        },
      })
      const handoff = await db.knowledgeProposalOperationalUpdateHandoff.create({
        data: {
          tenantId,
          venueId,
          proposalId: proposal.id,
          operationalUpdateId: update.id,
          previewHash,
          createdBy: 'temporal-integration-reviewer',
        },
      })

      await expect(
        db.knowledgeProposalOperationalUpdateHandoff.create({
          data: {
            tenantId,
            venueId,
            proposalId: proposal.id,
            operationalUpdateId: update.id,
            previewHash,
            createdBy: 'temporal-integration-reviewer',
          },
        }),
      ).rejects.toThrow()
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO knowledge_proposal_operational_update_handoffs
             (tenant_id, venue_id, proposal_id, operational_update_id, preview_hash, created_by)
           VALUES ($1, $2, $3::uuid, $4, $5, $6)`,
          otherTenantId,
          otherVenueId,
          proposal.id,
          update.id,
          previewHash,
          'cross-scope-attempt',
        ),
      ).rejects.toThrow()
      await expect(
        db.$executeRawUnsafe(
          'UPDATE knowledge_proposal_operational_update_handoffs SET created_by = $1 WHERE id = $2::uuid',
          'tampered',
          handoff.id,
        ),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.$executeRawUnsafe(
          'DELETE FROM knowledge_proposal_operational_update_handoffs WHERE id = $1::uuid',
          handoff.id,
        ),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.$executeRawUnsafe('TRUNCATE TABLE knowledge_proposal_operational_update_handoffs'),
      ).rejects.toThrow(/append-only/u)

      expect(
        await db.knowledgeProposalOperationalUpdateHandoff.findUniqueOrThrow({
          where: { id: handoff.id },
        }),
      ).toMatchObject({
        tenantId,
        venueId,
        proposalId: proposal.id,
        operationalUpdateId: update.id,
        previewHash,
      })
      expect(
        await db.operationalUpdate.findUniqueOrThrow({ where: { id: update.id } }),
      ).toMatchObject({ status: 'DRAFT', isActive: false, publishedAt: null })
    })
  })

  it('joins an exact semantic package bridge to human-gated lifecycle transitions and replay', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-semantic-lifecycle-${suffix}`
      const venueId = `venue-semantic-lifecycle-${suffix}`
      const operatorId = `semantic-lifecycle-operator-${suffix}`

      await db.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } })
      await db.venue.create({ data: { id: venueId, tenantId, name: venueId, slug: venueId } })
      const proposal = await db.knowledgeChangeProposal.create({
        data: {
          tenantId,
          venueId,
          proposedChange: 'Add reviewed arrival guidance.',
          reason: 'Disposable semantic lifecycle proof.',
          confidence: 0.98,
          status: 'APPROVED',
          createdByType: 'OPERATOR',
          createdById: operatorId,
          reviewerId: operatorId,
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
          payloadHash: 'e'.repeat(64),
          baseDigest: 'f'.repeat(64),
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
          createdBy: operatorId,
        },
      })
      const handoff = await db.knowledgeProposalPackageHandoff.create({
        data: {
          tenantId,
          venueId,
          proposalId: proposal.id,
          venuePackageId: venuePackage.id,
          previewHash: '1'.repeat(64),
          createdBy: operatorId,
        },
      })

      const load = (tx: typeof db, scope: { tenantId: string; id: string }) =>
        tx.venuePackage.findFirst({
          where: { id: scope.id, tenantId: scope.tenantId },
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            status: true,
            updatedAt: true,
            approvedCommandKey: true,
            approvedBy: true,
            appliedCommandKey: true,
            appliedBy: true,
            revertedCommandKey: true,
            revertedBy: true,
          },
        })
      const validate = async () => undefined
      const approvalEffects = async () => ({
        approvalWarningDigest: '3'.repeat(64),
        approvedWarningCodes: [],
      })
      const applyEffects = async () => ({ appliedEntities: { schemaVersion: 1 } })
      const auditState = (record: { id: string; status: string }) => ({
        id: record.id,
        status: record.status,
        semanticProposalId: proposal.id,
        semanticHandoffId: handoff.id,
      })
      const actor = { type: 'HUMAN' as const, id: operatorId, role: 'PLATFORM_ADMIN' as const }
      const unauthorizedAgent = {
        type: 'AGENT' as const,
        actorId: `semantic-agent-${suffix}`,
        role: 'AGENT' as const,
        agentIdentityId: `semantic-agent-${suffix}`,
        agentRunId: `semantic-run-${suffix}`,
        workerId: `semantic-worker-${suffix}`,
        credentialId: `semantic-credential-${suffix}`,
        approvalGrantId: `semantic-grant-${suffix}`,
        capability: 'packages:apply',
        idempotencyKey: `semantic-command-${suffix}`,
      }

      await expect(
        approveVenuePackageAction(
          {
            tenantId,
            id: venuePackage.id,
            expectedUpdatedAt: venuePackage.updatedAt,
            commandKey: randomUUID(),
            actor: unauthorizedAgent,
            load,
            validate,
            execute: approvalEffects,
            auditState,
          },
          db,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(
        db.venuePackage.findUniqueOrThrow({
          where: { id: venuePackage.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'DRAFT' })

      const approveCommand = randomUUID()
      const approved = await approveVenuePackageAction(
        {
          tenantId,
          id: venuePackage.id,
          expectedUpdatedAt: venuePackage.updatedAt,
          commandKey: approveCommand,
          actor,
          load,
          validate,
          execute: approvalEffects,
          auditState,
        },
        db,
      )
      expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: operatorId })
      await expect(
        approveVenuePackageAction(
          {
            tenantId,
            id: venuePackage.id,
            expectedUpdatedAt: venuePackage.updatedAt,
            commandKey: approveCommand,
            actor,
            load,
            validate,
            execute: approvalEffects,
            auditState,
          },
          db,
        ),
      ).resolves.toMatchObject({ status: 'APPROVED', approvedCommandKey: approveCommand })

      const applyCommand = randomUUID()
      const applied = await applyVenuePackageAction(
        {
          tenantId,
          id: venuePackage.id,
          expectedUpdatedAt: approved.updatedAt,
          commandKey: applyCommand,
          actor,
          load,
          validate,
          execute: applyEffects,
          auditState,
        },
        db,
      )
      expect(applied).toMatchObject({ status: 'APPLIED', appliedBy: operatorId })
      await expect(
        applyVenuePackageAction(
          {
            tenantId,
            id: venuePackage.id,
            expectedUpdatedAt: approved.updatedAt,
            commandKey: applyCommand,
            actor,
            load,
            validate,
            execute: applyEffects,
            auditState,
          },
          db,
        ),
      ).resolves.toMatchObject({ status: 'APPLIED', appliedCommandKey: applyCommand })

      const revertCommand = randomUUID()
      const reverted = await revertVenuePackageAction(
        {
          tenantId,
          id: venuePackage.id,
          expectedUpdatedAt: applied.updatedAt,
          commandKey: revertCommand,
          actor,
          load,
          validate,
          auditState,
        },
        db,
      )
      expect(reverted).toMatchObject({ status: 'REVERTED', revertedBy: operatorId })
      await expect(
        revertVenuePackageAction(
          {
            tenantId,
            id: venuePackage.id,
            expectedUpdatedAt: applied.updatedAt,
            commandKey: revertCommand,
            actor,
            load,
            validate,
            auditState,
          },
          db,
        ),
      ).resolves.toMatchObject({ status: 'REVERTED', revertedCommandKey: revertCommand })

      expect(
        await db.auditLog.count({
          where: {
            tenantId,
            targetType: 'VenuePackage',
            targetId: venuePackage.id,
            action: {
              in: ['venue-package.approved', 'venue-package.applied', 'venue-package.reverted'],
            },
          },
        }),
      ).toBe(3)
      expect(
        await db.knowledgeProposalPackageHandoff.findUniqueOrThrow({ where: { id: handoff.id } }),
      ).toMatchObject({ proposalId: proposal.id, venuePackageId: venuePackage.id })
    })
  })

  it('publishes and deactivates a proposal-linked temporal draft only through human actions', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-temporal-lifecycle-${suffix}`
      const venueId = `venue-temporal-lifecycle-${suffix}`
      const operatorId = `temporal-lifecycle-operator-${suffix}`
      const startsAt = new Date('2030-01-01T08:00:00.000Z')
      const expiresAt = new Date('2030-01-01T12:00:00.000Z')

      await db.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } })
      await db.venue.create({ data: { id: venueId, tenantId, name: venueId, slug: venueId } })
      const proposal = await db.knowledgeChangeProposal.create({
        data: {
          tenantId,
          venueId,
          proposedChange: 'Publish a reviewed temporary atrium closure.',
          reason: 'Disposable semantic temporal lifecycle proof.',
          confidence: 0.98,
          status: 'APPROVED',
          createdByType: 'OPERATOR',
          createdById: operatorId,
          reviewerId: operatorId,
          reviewedAt: new Date(),
        },
      })
      const update = await db.operationalUpdate.create({
        data: {
          tenantId,
          venueId,
          updateType: 'TEMPORARY_CLOSURE',
          severity: 'INFO',
          priority: 'NORMAL',
          title: 'Atrium closure',
          body: 'Closed for maintenance.',
          startsAt,
          expiresAt,
          status: 'DRAFT',
          isActive: false,
          createdBy: operatorId,
        },
      })
      const handoff = await db.knowledgeProposalOperationalUpdateHandoff.create({
        data: {
          tenantId,
          venueId,
          proposalId: proposal.id,
          operationalUpdateId: update.id,
          previewHash: '2'.repeat(64),
          createdBy: operatorId,
        },
      })
      const actor = { type: 'HUMAN' as const, id: operatorId, role: 'PLATFORM_ADMIN' as const }

      await expect(
        scheduleOperationalUpdateAction(
          {
            tenantId,
            actor: {
              type: 'AGENT',
              actorId: `temporal-agent-${suffix}`,
              role: 'AGENT',
            } as never,
            id: update.id,
            expectedUpdatedAt: update.updatedAt,
            now: new Date('2029-12-01T00:00:00.000Z'),
          },
          db,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(
        db.operationalUpdate.findUniqueOrThrow({
          where: { id: update.id },
          select: { status: true, isActive: true, publishedAt: true },
        }),
      ).resolves.toEqual({ status: 'DRAFT', isActive: false, publishedAt: null })

      const scheduled = await scheduleOperationalUpdateAction(
        {
          tenantId,
          actor,
          id: update.id,
          expectedUpdatedAt: update.updatedAt,
          now: new Date('2029-12-01T00:00:00.000Z'),
        },
        db,
      )
      expect(scheduled.update).toMatchObject({
        status: 'PUBLISHED',
        isActive: true,
        publishedBy: operatorId,
      })
      expect(scheduled.preview).toMatchObject({ lifecycle: 'SCHEDULED', guestVisibleNow: false })
      await expect(
        scheduleOperationalUpdateAction(
          {
            tenantId,
            actor,
            id: update.id,
            expectedUpdatedAt: update.updatedAt,
            now: new Date('2029-12-01T00:00:00.000Z'),
          },
          db,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      const deactivated = await expireOperationalUpdateAction(
        {
          tenantId,
          actor,
          id: update.id,
          expectedUpdatedAt: scheduled.update.updatedAt,
          now: new Date('2030-01-02T00:00:00.000Z'),
        },
        db,
      )
      expect(deactivated.update).toMatchObject({ status: 'PUBLISHED', isActive: false })
      expect(deactivated.preview).toMatchObject({ lifecycle: 'INACTIVE', guestVisibleNow: false })
      expect(
        await db.auditLog.count({
          where: {
            tenantId,
            targetType: 'OperationalUpdate',
            targetId: update.id,
            action: { in: ['operational-update.published', 'operational-update.deactivated'] },
          },
        }),
      ).toBe(2)
      expect(
        await db.knowledgeProposalOperationalUpdateHandoff.findUniqueOrThrow({
          where: { id: handoff.id },
        }),
      ).toMatchObject({ proposalId: proposal.id, operationalUpdateId: update.id })
    })
  })
})

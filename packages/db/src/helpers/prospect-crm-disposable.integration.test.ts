import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  approveProspectImportAction,
  beginProspectImportAction,
  commitProspectImportBatchAction,
  createProspectAction,
  db,
  linkProspectConversionAction,
  previewProspectImportRepairAction,
  recordProspectInboundReplyAction,
  repairProspectImportAction,
  resolveProspectImportRowAction,
  stageProspectImportRowsAction,
  updateProspectPipelineAction,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_PROSPECT_CRM_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

describe.skipIf(!enabled)('prospect CRM disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('proves review-gated import, partial failure, idempotency, provenance, and unique conversion', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const existing = await createProspectAction({
        organization: {
          canonicalName: `Existing Theatre ${suffix}`,
          website: `https://existing-${suffix}.example.test`,
          source: 'disposable-test',
        },
        venue: { name: `Existing Theatre ${suffix}`, city: 'Chicago', region: 'IL' },
        actor,
      })
      await expect(
        createProspectAction({
          organization: { canonicalName: ` Existing  Theatre ${suffix} ` },
          actor,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      await updateProspectPipelineAction({
        organizationId: existing.organization.id,
        stage: 'CONTACTED',
        reason: 'Disposable inbound-reply continuity setup',
        actor,
      })
      const replyAt = new Date('2026-08-22T16:00:00.000Z')
      const reply = await recordProspectInboundReplyAction({
        prospectOrganizationId: existing.organization.id,
        contactId: null,
        campaignMemberId: null,
        canonicalMessageId: `message-${suffix}`,
        canonicalThreadId: `thread-${suffix}`,
        matchingEvidence: ['PROVIDER_THREAD', 'RFC_REFERENCE'],
        occurredAt: replyAt,
      })
      expect(reply).toMatchObject({
        fromStage: 'CONTACTED',
        toStage: 'REPLIED',
        stageChanged: true,
      })
      expect(
        await db.prospectOpportunity.findUniqueOrThrow({
          where: { organizationId: existing.organization.id },
          select: { stage: true, lastActivityAt: true },
        }),
      ).toEqual({ stage: 'REPLIED', lastActivityAt: replyAt })
      expect(
        await db.prospectStageHistory.count({
          where: {
            opportunity: { organizationId: existing.organization.id },
            fromStage: 'CONTACTED',
            toStage: 'REPLIED',
            actorId: 'gmail-sync',
          },
        }),
      ).toBe(1)
      expect(
        await db.auditLog.count({
          where: {
            action: 'system.prospect.inbound_reply_recorded',
            targetId: reply.opportunityId!,
          },
        }),
      ).toBe(1)

      const fileHash = hash(`file-${suffix}`)
      const mappingHash = hash(`mapping-${suffix}`)
      const started = await beginProspectImportAction({
        fileName: 'sanitized-prospects.xlsx',
        fileType: 'xlsx',
        fileSize: 4096,
        fileHash,
        mappingHash,
        mapping: { venueName: 'venue_name' },
        sheets: [
          {
            sheetName: 'Chicago',
            sheetIndex: 0,
            detectedRows: 4,
            columns: ['venue_name', 'owner_name', 'website', 'contact_email'],
          },
        ],
        actor,
      })
      const importId = started.prospectImport.id
      const staged = await stageProspectImportRowsAction({
        importId,
        rows: [
          {
            sheetName: 'Chicago',
            originalRowNumber: 2,
            sourceValues: { venue_name: `North Star Hall ${suffix}` },
            normalizedValues: {
              venueName: `North Star Hall ${suffix}`,
              organizationName: `North Star Arts ${suffix}`,
              city: 'Chicago',
              region: 'IL',
              contactEmail: `hello-${suffix}@northstar.example.test`,
              sourceUrls: ['https://northstar.example.test/source'],
              researchConfidence: 'high',
              territory: 'Chicago',
            },
          },
          {
            sheetName: 'Chicago',
            originalRowNumber: 3,
            sourceValues: { venue_name: `Failure Fixture ${suffix}` },
            normalizedValues: {
              venueName: `Failure Fixture ${suffix}`,
              organizationName: `Failure Fixture Org ${suffix}`,
              city: 'Chicago',
            },
          },
          {
            sheetName: 'Chicago',
            originalRowNumber: 4,
            sourceValues: { venue_name: `Existing Theatre ${suffix}` },
            normalizedValues: {
              venueName: `Existing Theatre ${suffix}`,
              organizationName: `Existing Theatre ${suffix}`,
              city: 'Chicago',
              website: `https://existing-${suffix}.example.test`,
            },
          },
          {
            sheetName: 'Chicago',
            originalRowNumber: 5,
            sourceValues: { venue_name: '' },
            normalizedValues: { venueName: '' },
          },
        ],
        actor,
      })
      expect(staged.totalRows).toBe(4)
      const rows = await db.prospectImportRow.findMany({
        where: { importId },
        orderBy: { originalRowNumber: 'asc' },
      })
      expect(rows.map((row) => row.status)).toEqual([
        'WARNING',
        'WARNING',
        'DUPLICATE_REVIEW',
        'FAILED',
      ])
      await expect(approveProspectImportAction({ importId, actor })).rejects.toMatchObject({
        code: 'CONFLICT',
      })
      await resolveProspectImportRowAction({
        importId,
        rowId: rows[2]!.id,
        decision: 'LINK_EXISTING',
        targetOrganizationId: existing.organization.id,
        targetVenueId: existing.venue?.id,
        note: 'Exact existing name and domain verified in disposable test',
        actor,
      })
      await approveProspectImportAction({ importId, actor })

      await db.prospectImportRow.update({
        where: { id: rows[1]!.id },
        data: { normalizedValues: { deliberatelyCorrupted: true } },
      })
      const concurrent = await Promise.all([
        commitProspectImportBatchAction({ importId, limit: 100, workerId: 'worker-a', actor }),
        commitProspectImportBatchAction({ importId, limit: 100, workerId: 'worker-b', actor }),
      ])
      expect(concurrent.reduce((sum, item) => sum + item.processed, 0)).toBe(2)
      expect(concurrent.reduce((sum, item) => sum + item.failed, 0)).toBe(1)
      const committed = await db.prospectImport.findUniqueOrThrow({ where: { id: importId } })
      expect(committed.status).toBe('PARTIAL')
      const replayCommit = await commitProspectImportBatchAction({ importId, limit: 100, actor })
      expect(replayCommit).toMatchObject({ processed: 0, failed: 0, done: true })

      const importedRow = await db.prospectImportRow.findUniqueOrThrow({
        where: { id: rows[0]!.id },
      })
      expect(importedRow.status).toBe('IMPORTED')
      expect(importedRow.importedOrganizationId).toBeTruthy()
      expect(
        await db.prospectSourceEvidence.count({ where: { importRowId: importedRow.id } }),
      ).toBe(1)
      expect(
        await db.prospectActivity.count({
          where: { organizationId: importedRow.importedOrganizationId!, type: 'IMPORTED' },
        }),
      ).toBe(1)
      const replayImport = await beginProspectImportAction({
        fileName: 'renamed-but-identical.xlsx',
        fileType: 'xlsx',
        fileSize: 4096,
        fileHash,
        mappingHash,
        mapping: { venueName: 'venue_name' },
        sheets: [{ sheetName: 'Chicago', sheetIndex: 0, detectedRows: 4, columns: ['venue_name'] }],
        actor,
      })
      expect(replayImport).toMatchObject({ replayed: true })
      expect(replayImport.prospectImport.id).toBe(importId)

      const repairPlan = await previewProspectImportRepairAction({ importId, actor })
      expect(repairPlan).toMatchObject({
        organizations: 1,
        blockers: { campaignMembers: 0, messages: 0, relationships: 0 },
      })
      await expect(
        repairProspectImportAction({
          importId,
          expectedPlanHash: '0'.repeat(64),
          reason: 'Disposable stale preview check',
          actor,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const repaired = await repairProspectImportAction({
        importId,
        expectedPlanHash: repairPlan.planHash,
        reason: 'Disposable reviewed archive repair',
        actor,
      })
      expect(repaired.prospectImport.status).toBe('REPAIRED')
      expect(
        await db.prospectOrganization.findUniqueOrThrow({
          where: { id: importedRow.importedOrganizationId! },
          select: { archivedAt: true },
        }),
      ).toMatchObject({ archivedAt: expect.any(Date) })
      expect(
        await db.prospectOrganization.findUniqueOrThrow({
          where: { id: existing.organization.id },
          select: { archivedAt: true },
        }),
      ).toEqual({ archivedAt: null })

      const tenantId = `tenant-prospect-${suffix}`
      const venueId = `venue-prospect-${suffix}`
      await db.tenant.create({ data: { id: tenantId, name: 'Converted customer', slug: tenantId } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Converted venue', slug: venueId },
      })
      const converted = await linkProspectConversionAction({
        organizationId: existing.organization.id,
        prospectVenueId: existing.venue!.id,
        tenantId,
        venueId,
        evidence: { source: 'disposable-integration' },
        actor,
      })
      expect(converted.replayed).toBe(false)
      const conversionReplay = await linkProspectConversionAction({
        organizationId: existing.organization.id,
        prospectVenueId: existing.venue!.id,
        tenantId,
        venueId,
        actor,
      })
      expect(conversionReplay.replayed).toBe(true)
      expect(
        await db.prospectCustomerRelationship.count({
          where: { organizationId: existing.organization.id },
        }),
      ).toBe(1)
      expect(
        await db.prospectStageHistory.count({
          where: { opportunity: { organizationId: existing.organization.id }, toStage: 'WON' },
        }),
      ).toBe(1)
      expect(
        await db.prospectActivity.count({
          where: { organizationId: existing.organization.id, type: 'CONVERTED_TO_CUSTOMER' },
        }),
      ).toBe(1)
    })
  }, 30_000)
})

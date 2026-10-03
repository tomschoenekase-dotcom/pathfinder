import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  approveProspectImportAction,
  beginProspectImportAction,
  commitProspectImportBatchAction,
  createProspectAction,
  db,
  linkProspectConversionAction,
  mergeProspectOrganizationsAction,
  previewProspectImportRepairAction,
  previewProspectOrganizationMergeAction,
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

  it('merges two ordinary accounts after a fresh preview, retaining contact and mail history', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const source = await createProspectAction({
        organization: { canonicalName: `Example Arts North ${suffix}` },
        venue: { name: `Example North ${suffix}`, city: 'Chicago', region: 'IL' },
        actor,
      })
      const target = await createProspectAction({
        organization: { canonicalName: `Example Arts ${suffix}` },
        venue: { name: `Example South ${suffix}`, city: 'Evanston', region: 'IL' },
        actor,
      })
      const contact = await db.prospectContact.create({
        data: {
          organizationId: source.organization.id,
          venueId: source.venue!.id,
          fullName: 'Casey Example',
          email: `casey-${suffix}@example.test`,
          normalizedEmail: `casey-${suffix}@example.test`,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      const thread = await db.prospectEmailThread.create({
        data: {
          organizationId: source.organization.id,
          venueId: source.venue!.id,
          contactId: contact.id,
          replyTokenHash: hash(`thread-${suffix}`),
          subject: 'Example correspondence',
        },
      })
      const message = await db.prospectEmailMessage.create({
        data: {
          threadId: thread.id,
          organizationId: source.organization.id,
          venueId: source.venue!.id,
          contactId: contact.id,
          direction: 'OUTBOUND',
          status: 'SENT',
          fromAddress: 'operator@example.test',
          toAddresses: [`casey-${suffix}@example.test`],
          subject: 'Example correspondence',
          occurredAt: new Date(),
        },
      })
      const before = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
      })
      expect(before.counts).toMatchObject({
        prospectContact: 1,
        prospectVenue: 1,
        prospectEmailThread: 1,
        prospectEmailMessage: 1,
      })
      expect(before.blockers).toEqual([])
      await db.prospectActivity.create({
        data: {
          organizationId: source.organization.id,
          type: 'NOTE_ADDED',
          summary: 'A review-time note',
          actorId: actor.id,
        },
      })
      await expect(
        mergeProspectOrganizationsAction({
          sourceOrganizationId: source.organization.id,
          targetOrganizationId: target.organization.id,
          expectedPlanHash: before.planHash,
          note: 'Same parent account, verified by a person',
          actor,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const refreshed = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
      })
      const applied = await mergeProspectOrganizationsAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
        expectedPlanHash: refreshed.planHash,
        note: 'Same parent account, verified by a person',
        actor,
      })
      expect(applied.replayed).toBe(false)
      expect(
        await db.prospectOrganization.findUniqueOrThrow({ where: { id: source.organization.id } }),
      ).toMatchObject({
        mergedIntoOrganizationId: target.organization.id,
        archivedAt: expect.any(Date),
      })
      expect(
        await db.prospectContact.findUniqueOrThrow({ where: { id: contact.id } }),
      ).toMatchObject({
        organizationId: target.organization.id,
        venueId: source.venue!.id,
        email: contact.email,
      })
      expect(
        await db.prospectEmailThread.findUniqueOrThrow({ where: { id: thread.id } }),
      ).toMatchObject({
        organizationId: target.organization.id,
        contactId: contact.id,
      })
      expect(
        await db.prospectEmailMessage.findUniqueOrThrow({ where: { id: message.id } }),
      ).toMatchObject({
        organizationId: target.organization.id,
        threadId: thread.id,
        status: 'SENT',
      })
      expect(
        await db.prospectOpportunity.findUniqueOrThrow({
          where: { organizationId: source.organization.id },
        }),
      ).toMatchObject({ organizationId: source.organization.id })
      expect(
        await db.prospectOrganizationMerge.findUniqueOrThrow({
          where: { sourceOrganizationId: source.organization.id },
        }),
      ).toMatchObject({
        targetOrganizationId: target.organization.id,
        planHash: refreshed.planHash,
      })
      expect(
        await mergeProspectOrganizationsAction({
          sourceOrganizationId: source.organization.id,
          targetOrganizationId: target.organization.id,
          expectedPlanHash: refreshed.planHash,
          note: 'Replay of exact reviewed merge',
          actor,
        }),
      ).toMatchObject({ replayed: true, receipt: { id: applied.receipt.id } })
    })
  })

  it('refuses a merge while a source research job still owns account work', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const source = await createProspectAction({
        organization: { canonicalName: `Example Research North ${suffix}` },
        actor,
      })
      const target = await createProspectAction({
        organization: { canonicalName: `Example Research ${suffix}` },
        actor,
      })
      await db.prospectResearchJob.create({
        data: { organizationId: source.organization.id, queuedBy: actor.id },
      })
      const plan = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
      })
      expect(plan.blockers).toContain('prospectResearchJob:requires-separate-reviewed-resolution')
      await expect(
        mergeProspectOrganizationsAction({
          sourceOrganizationId: source.organization.id,
          targetOrganizationId: target.organization.id,
          expectedPlanHash: plan.planHash,
          note: 'Should refuse while research remains attached',
          actor,
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_MERGE' })
      expect(
        await db.prospectOrganization.findUniqueOrThrow({ where: { id: source.organization.id } }),
      ).toMatchObject({ archivedAt: null, mergedIntoOrganizationId: null })
    })
  })

  it('refuses live followups and inbound correspondence instead of reactivating or losing them', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const source = await createProspectAction({
        organization: { canonicalName: `Example Followup North ${suffix}` },
        actor,
      })
      const target = await createProspectAction({
        organization: { canonicalName: `Example Followup ${suffix}` },
        actor,
      })
      const sourceOpportunity = await db.prospectOpportunity.findUniqueOrThrow({
        where: { organizationId: source.organization.id },
      })
      const followup = await db.prospectFollowup.create({
        data: {
          organizationId: source.organization.id,
          opportunityId: sourceOpportunity.id,
          dueAt: new Date(),
          sequenceNumber: 1,
          status: 'PENDING',
        },
      })
      const thread = await db.prospectEmailThread.create({
        data: { organizationId: source.organization.id, replyTokenHash: hash(`inbound-${suffix}`) },
      })
      const inbound = await db.prospectEmailMessage.create({
        data: {
          threadId: thread.id,
          organizationId: source.organization.id,
          direction: 'INBOUND',
          status: 'RECEIVED',
          fromAddress: 'example@example.test',
          toAddresses: ['operator@example.test'],
          subject: 'Example reply',
          occurredAt: new Date(),
        },
      })
      const plan = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: source.organization.id,
        targetOrganizationId: target.organization.id,
      })
      expect(plan.blockers).toContain('active-followups:1')
      expect(plan.blockers).toContain(
        'inbound-or-unsettled-messages-require-source-bound-history:1',
      )
      await expect(
        mergeProspectOrganizationsAction({
          sourceOrganizationId: source.organization.id,
          targetOrganizationId: target.organization.id,
          expectedPlanHash: plan.planHash,
          note: 'Must refuse active correspondence',
          actor,
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_MERGE' })
      expect(
        await db.prospectFollowup.findUniqueOrThrow({ where: { id: followup.id } }),
      ).toMatchObject({ organizationId: source.organization.id, status: 'PENDING' })
      expect(
        await db.prospectEmailMessage.findUniqueOrThrow({ where: { id: inbound.id } }),
      ).toMatchObject({ organizationId: source.organization.id, status: 'RECEIVED' })
    })
  })

  it('keeps a source stop stage from being weakened while allowing a stopped target', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const stoppedSource = await createProspectAction({
        organization: { canonicalName: `Example Stopped North ${suffix}` },
        actor,
      })
      const activeTarget = await createProspectAction({
        organization: { canonicalName: `Example Active Parent ${suffix}` },
        actor,
      })
      const contact = await db.prospectContact.create({
        data: {
          organizationId: stoppedSource.organization.id,
          email: `stopped-${suffix}@example.test`,
          normalizedEmail: `stopped-${suffix}@example.test`,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      await updateProspectPipelineAction({
        organizationId: stoppedSource.organization.id,
        stage: 'DO_NOT_CONTACT',
        reason: 'Source account requested no contact',
        actor,
      })
      const blocked = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: stoppedSource.organization.id,
        targetOrganizationId: activeTarget.organization.id,
      })
      expect(blocked.blockers).toContain(
        'source-stop-stage-would-be-weakened:DO_NOT_CONTACT:DISCOVERED',
      )
      await expect(
        mergeProspectOrganizationsAction({
          sourceOrganizationId: stoppedSource.organization.id,
          targetOrganizationId: activeTarget.organization.id,
          expectedPlanHash: blocked.planHash,
          note: 'Must retain source stop',
          actor,
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_MERGE' })
      expect(
        await db.prospectContact.findUniqueOrThrow({ where: { id: contact.id } }),
      ).toMatchObject({ organizationId: stoppedSource.organization.id })
      expect(
        await db.prospectOrganization.findUniqueOrThrow({
          where: { id: stoppedSource.organization.id },
        }),
      ).toMatchObject({ archivedAt: null })

      const activeSource = await createProspectAction({
        organization: { canonicalName: `Example Active North ${suffix}` },
        actor,
      })
      const stoppedTarget = await createProspectAction({
        organization: { canonicalName: `Example Stopped Parent ${suffix}` },
        actor,
      })
      await updateProspectPipelineAction({
        organizationId: stoppedTarget.organization.id,
        stage: 'DO_NOT_CONTACT',
        reason: 'Canonical account requested no contact',
        actor,
      })
      const safe = await previewProspectOrganizationMergeAction({
        sourceOrganizationId: activeSource.organization.id,
        targetOrganizationId: stoppedTarget.organization.id,
      })
      expect(safe.blockers).toEqual([])
      await mergeProspectOrganizationsAction({
        sourceOrganizationId: activeSource.organization.id,
        targetOrganizationId: stoppedTarget.organization.id,
        expectedPlanHash: safe.planHash,
        note: 'Canonical stop remains in force',
        actor,
      })
      expect(
        await db.prospectOpportunity.findUniqueOrThrow({
          where: { organizationId: stoppedTarget.organization.id },
        }),
      ).toMatchObject({ stage: 'DO_NOT_CONTACT' })
    })
  })

  it('imports explicit CRM IDs into the right parent and distinct locations without losing contacts', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const parent = await createProspectAction({
        organization: { canonicalName: `Example Arts ${suffix}` },
        venue: { name: `Example Arts North ${suffix}`, city: 'Chicago', region: 'IL' },
        actor,
      })
      const originalContact = await db.prospectContact.create({
        data: {
          organizationId: parent.organization.id,
          venueId: parent.venue!.id,
          fullName: 'Casey Example',
          email: `casey-${suffix}@example.test`,
          normalizedEmail: `casey-${suffix}@example.test`,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      const started = await beginProspectImportAction({
        fileName: 'example-locations.csv',
        fileType: 'csv',
        fileSize: 1024,
        fileHash: hash(`locations-${suffix}`),
        mappingHash: hash(`locations-mapping-${suffix}`),
        mapping: { venueName: 'name', existingOrganizationId: 'organization_id' },
        sheets: [
          {
            sheetName: 'Locations',
            sheetIndex: 0,
            detectedRows: 2,
            columns: ['name', 'organization_id', 'venue_id'],
          },
        ],
        actor,
      })
      const importId = started.prospectImport.id
      await stageProspectImportRowsAction({
        importId,
        rows: [
          {
            sheetName: 'Locations',
            originalRowNumber: 2,
            sourceValues: { name: `Example Arts North ${suffix}` },
            normalizedValues: {
              venueName: `Example Arts North ${suffix}`,
              organizationName: `Example Arts ${suffix}`,
              existingOrganizationId: parent.organization.id,
              existingVenueId: parent.venue!.id,
              city: 'Chicago',
              region: 'IL',
              contactEmail: `north-${suffix}@example.test`,
            },
          },
          {
            sheetName: 'Locations',
            originalRowNumber: 3,
            sourceValues: { name: `Example Arts South ${suffix}` },
            normalizedValues: {
              venueName: `Example Arts South ${suffix}`,
              organizationName: `Example Arts ${suffix}`,
              existingOrganizationId: parent.organization.id,
              city: 'Evanston',
              region: 'IL',
              contactEmail: `south-${suffix}@example.test`,
            },
          },
        ],
        actor,
      })
      const staged = await db.prospectImportRow.findMany({
        where: { importId },
        orderBy: { originalRowNumber: 'asc' },
      })
      expect(staged.map((row) => row.status)).toEqual(['WARNING', 'WARNING'])
      expect(staged.map((row) => row.targetOrganizationId)).toEqual([
        parent.organization.id,
        parent.organization.id,
      ])
      expect(staged.map((row) => row.targetVenueId)).toEqual([parent.venue!.id, null])
      await approveProspectImportAction({ importId, actor })
      const result = await commitProspectImportBatchAction({ importId, actor })
      expect(result).toMatchObject({ processed: 2, failed: 0, done: true })
      const committed = await db.prospectImportRow.findMany({
        where: { importId },
        orderBy: { originalRowNumber: 'asc' },
      })
      expect(committed.map((row) => row.importedOrganizationId)).toEqual([
        parent.organization.id,
        parent.organization.id,
      ])
      expect(committed[0]!.importedVenueId).toBe(parent.venue!.id)
      expect(committed[1]!.importedVenueId).not.toBe(parent.venue!.id)
      expect(
        await db.prospectContact.findUnique({ where: { id: originalContact.id } }),
      ).toMatchObject({ organizationId: parent.organization.id, venueId: parent.venue!.id })
      expect(
        await db.prospectSourceEvidence.count({
          where: { importRowId: { in: staged.map((row) => row.id) } },
        }),
      ).toBe(2)
      expect(await commitProspectImportBatchAction({ importId, actor })).toMatchObject({
        processed: 0,
        failed: 0,
        done: true,
      })
    })
  })

  it('reuses an existing parent location when import casing differs', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const parent = await createProspectAction({
        organization: { canonicalName: `Example Location Parent ${suffix}` },
        venue: { name: `Example Hall ${suffix}`, city: 'Chicago', region: 'IL', country: 'US' },
        actor,
      })
      await db.prospectVenue.update({
        where: { id: parent.venue!.id },
        data: { addressLine1: '123 Example Street', postalCode: '60601' },
      })
      const started = await beginProspectImportAction({
        fileName: 'example-case.csv',
        fileType: 'csv',
        fileSize: 1024,
        fileHash: hash(`case-file-${suffix}`),
        mappingHash: hash(`case-mapping-${suffix}`),
        mapping: { venueName: 'name', existingOrganizationId: 'organization_id' },
        sheets: [
          {
            sheetName: 'Locations',
            sheetIndex: 0,
            detectedRows: 1,
            columns: ['name', 'organization_id'],
          },
        ],
        actor,
      })
      const importId = started.prospectImport.id
      await stageProspectImportRowsAction({
        importId,
        rows: [
          {
            sheetName: 'Locations',
            originalRowNumber: 2,
            sourceValues: { name: `Example Hall ${suffix}` },
            normalizedValues: {
              venueName: `Example Hall ${suffix}`,
              organizationName: `Example Location Parent ${suffix}`,
              existingOrganizationId: parent.organization.id,
              city: 'chicago',
              region: 'il',
              country: 'us',
              addressLine1: '123 example street',
              postalCode: '60601',
            },
          },
        ],
        actor,
      })
      const staged = await db.prospectImportRow.findFirstOrThrow({ where: { importId } })
      expect(staged.targetVenueId).toBe(parent.venue!.id)
      await approveProspectImportAction({ importId, actor })
      expect(await commitProspectImportBatchAction({ importId, actor })).toMatchObject({
        processed: 1,
        failed: 0,
        done: true,
      })
      expect(
        await db.prospectImportRow.findUniqueOrThrow({ where: { id: staged.id } }),
      ).toMatchObject({ importedVenueId: parent.venue!.id })
      expect(
        await db.prospectVenue.count({ where: { organizationId: parent.organization.id } }),
      ).toBe(1)
    })
  })

  it('refuses canonical approval of a complete native CSV with one valid and one failed row', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const started = await beginProspectImportAction({
        fileName: 'example-mixed.csv',
        fileType: 'csv',
        fileSize: 1024,
        fileHash: hash(`mixed-file-${suffix}`),
        mappingHash: hash(`mixed-mapping-${suffix}`),
        mapping: { venueName: 'name' },
        sheets: [{ sheetName: 'Locations', sheetIndex: 0, detectedRows: 2, columns: ['name'] }],
        actor,
      })
      const importId = started.prospectImport.id
      await stageProspectImportRowsAction({
        importId,
        rows: [
          {
            sheetName: 'Locations',
            originalRowNumber: 2,
            sourceValues: { name: `Example Valid ${suffix}` },
            normalizedValues: { venueName: `Example Valid ${suffix}` },
          },
          {
            sheetName: 'Locations',
            originalRowNumber: 3,
            sourceValues: { name: '' },
            normalizedValues: { venueName: '', organizationName: `Example Invalid ${suffix}` },
          },
        ],
        actor,
      })
      await db.prospectImport.update({
        where: { id: importId },
        data: { packageManifest: { mcpCsv: true, sourceRows: 2, stagingComplete: true } },
      })
      expect(
        await db.prospectImportRow.groupBy({
          by: ['status'],
          where: { importId },
          _count: { _all: true },
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'WARNING', _count: { _all: 1 } }),
          expect.objectContaining({ status: 'FAILED', _count: { _all: 1 } }),
        ]),
      )
      await expect(approveProspectImportAction({ importId, actor })).rejects.toMatchObject({
        code: 'CONFLICT',
      })
      expect(await db.prospectImport.findUniqueOrThrow({ where: { id: importId } })).toMatchObject({
        status: 'DRY_RUN_READY',
        approvedAt: null,
      })
    })
  })

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

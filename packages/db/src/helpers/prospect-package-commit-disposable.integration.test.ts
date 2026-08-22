import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { admitProspectStagingPackageAction } from './prospect-package-admission-actions'
import {
  approveProspectStagingPackageCommitAction,
  claimProspectStagingPackageRecordsAction,
  commitProspectStagingPackageClaimAction,
  finalizeProspectStagingPackageAction,
} from './prospect-package-commit-actions'

const enabled = process.env.RUN_PROSPECT_PACKAGE_DB_INTEGRATION === '1'
const suite = enabled ? describe : describe.skip
const actor = {
  type: 'HUMAN' as const,
  id: 'packet-e-integration-admin',
  role: 'PLATFORM_ADMIN' as const,
}
const suffix = randomUUID()
const workbookHash = createHash('sha256').update(suffix).digest('hex')

function stagingPackage() {
  return {
    schema: 'torchiko.prospect-staging-package/v1',
    packageId: `packet-e-disposable-package-${suffix}`,
    sourceSystem: 'HERMES_STAGING',
    createdAt: '2026-08-22T16:00:00.000Z',
    sourceWorkbook: { name: 'synthetic.xlsx', sha256: workbookHash, rowCount: 1 },
    lineage: { runId: 'hermes-run-disposable', promptVersion: 'prompt-v1', models: ['test-model'] },
    counts: {
      PROSPECT: 1,
      CONTACT: 1,
      EVIDENCE: 1,
      DRAFT: 1,
      DUPLICATE_REVIEW: 0,
      EXCEPTION: 0,
      RUN_LOG: 0,
    },
    records: [
      {
        kind: 'PROSPECT',
        externalId: 'prospect-1',
        raw: { Name: 'Packet E Museum', City: 'Chicago' },
        normalized: {
          organizationExternalId: 'organization-1',
          organizationName: 'Packet E Museum',
          venueName: 'Packet E Museum - Main',
          city: 'Chicago',
          region: 'IL',
          duplicateOutcome: 'KEEP_DISTINCT',
        },
        status: 'RESEARCHED',
      },
      {
        kind: 'CONTACT',
        externalId: 'contact-1',
        parentExternalId: 'prospect-1',
        raw: { Email: `curator-${suffix}@packet-e.example` },
        normalized: { fullName: 'Casey Curator', email: `curator-${suffix}@packet-e.example` },
        status: 'RESEARCHED',
      },
      {
        kind: 'EVIDENCE',
        externalId: 'evidence-1',
        parentExternalId: 'contact-1',
        raw: { url: 'https://packet-e.example/contact' },
        normalized: { sourceType: 'PUBLIC_WEB', url: 'https://packet-e.example/contact' },
        status: 'CURRENT',
      },
      {
        kind: 'DRAFT',
        externalId: 'draft-1',
        parentExternalId: 'contact-1',
        raw: { subject: 'A grounded hello', body: 'A sourced and inert outreach draft.' },
        normalized: {},
        status: 'DRAFT',
        draftVersion: 1,
        supportingEvidenceIds: ['evidence-1'],
        humanReviewStatus: 'NOT_REVIEWED',
        sendAuthority: 'NONE',
      },
    ],
  }
}

suite('staging package disposable commit', () => {
  afterAll(async () => {
    await db.$disconnect()
  })

  it('commits canonical lineage once and keeps the imported draft inert', async () => {
    await withTenantIsolationBypass(async () => {
      const admitted = await admitProspectStagingPackageAction({ package: stagingPackage(), actor })
      await approveProspectStagingPackageCommitAction({ importId: admitted.importId, actor })
      let claimCount = 0
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const claim = await claimProspectStagingPackageRecordsAction({
          importId: admitted.importId,
          workerId: 'packet-e-disposable-worker',
          limit: 1,
        })
        if (!claim) break
        claimCount += 1
        const committed = await commitProspectStagingPackageClaimAction({
          claimToken: claim.claimToken,
          workerId: 'packet-e-disposable-worker',
        })
        expect(committed.failed).toBe(0)
        expect(committed.processed).toBe(1)
      }
      expect(claimCount).toBe(4)
      const finalized = await finalizeProspectStagingPackageAction({ importId: admitted.importId })
      expect(finalized).toMatchObject({ finalized: true, status: 'COMPLETE' })

      const records = await db.prospectImportSourceRecord.findMany({
        where: { importId: admitted.importId },
        orderBy: { recordKind: 'asc' },
      })
      expect(records).toHaveLength(4)
      expect(records.every((record) => record.processingStatus === 'COMPLETE')).toBe(true)
      expect(records.find((record) => record.recordKind === 'PROSPECT')).toMatchObject({
        canonicalOrganizationId: expect.any(String),
        canonicalVenueId: expect.any(String),
      })
      expect(records.find((record) => record.recordKind === 'CONTACT')).toMatchObject({
        canonicalContactId: expect.any(String),
      })
      expect(records.find((record) => record.recordKind === 'EVIDENCE')).toMatchObject({
        canonicalEvidenceId: expect.any(String),
      })
      expect(records.find((record) => record.recordKind === 'DRAFT')).toMatchObject({
        canonicalDraftId: expect.any(String),
      })
      const draft = await db.prospectOutreachDraft.findUnique({
        where: { id: records.find((record) => record.recordKind === 'DRAFT')!.canonicalDraftId! },
      })
      expect(draft).toMatchObject({ status: 'NEEDS_REVIEW', approvedAt: null, approvedBy: null })
      expect(await db.prospectSendBatch.count({ where: { campaignId: draft!.campaignId } })).toBe(0)
      expect(
        await db.prospectSendOutbox.count({ where: { sendItem: { draftId: draft!.id } } }),
      ).toBe(0)
      expect(
        await db.prospectEmailMessage.count({ where: { sendItem: { draftId: draft!.id } } }),
      ).toBe(0)

      const replay = await admitProspectStagingPackageAction({ package: stagingPackage(), actor })
      expect(replay).toMatchObject({ importId: admitted.importId, replayed: true })
      const prospect = records.find((record) => record.recordKind === 'PROSPECT')!
      const contact = records.find((record) => record.recordKind === 'CONTACT')!
      const evidence = records.find((record) => record.recordKind === 'EVIDENCE')!
      expect(
        await db.prospectOrganization.count({ where: { id: prospect.canonicalOrganizationId! } }),
      ).toBe(1)
      expect(await db.prospectVenue.count({ where: { id: prospect.canonicalVenueId! } })).toBe(1)
      expect(await db.prospectContact.count({ where: { id: contact.canonicalContactId! } })).toBe(1)
      expect(
        await db.prospectSourceEvidence.count({ where: { id: evidence.canonicalEvidenceId! } }),
      ).toBe(1)
      expect(await db.prospectOutreachDraft.count({ where: { id: draft!.id } })).toBe(1)
    })
  }, 60_000)
})

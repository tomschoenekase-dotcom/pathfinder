import { describe, expect, it, vi } from 'vitest'

import {
  approveProspectStagingPackageCommitAction,
  commitProspectStagingPackageClaimAction,
  finalizeProspectStagingPackageAction,
} from './prospect-package-commit-actions'

const actor = {
  type: 'HUMAN' as const,
  id: 'local-import-authorizer',
  role: 'PLATFORM_ADMIN' as const,
}
const counts = {
  PROSPECT: 1,
  CONTACT: 1,
  EVIDENCE: 1,
  DRAFT: 0,
  DUPLICATE_REVIEW: 0,
  EXCEPTION: 0,
  RUN_LOG: 0,
}
const source = {
  id: 'import-1',
  status: 'DRAFT',
  packageHash: 'a'.repeat(64),
  sourceWorkbookHash: 'b'.repeat(64),
  totalRows: 1,
  packageManifest: { counts },
}

describe('source-only package acceptance', () => {
  it('approves a source import without creating any campaign or draft', async () => {
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue(source),
        update: vi.fn().mockResolvedValue({ status: 'PROCESSING' }),
      },
      prospectOutreachCampaign: { upsert: vi.fn() },
      prospectOutreachDraft: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    expect(
      await approveProspectStagingPackageCommitAction(
        { importId: source.id, actor },
        client as never,
      ),
    ).toMatchObject({ status: 'PROCESSING', campaignId: null })
    expect(tx.prospectOutreachCampaign.upsert).not.toHaveBeenCalled()
    expect(tx.prospectOutreachDraft.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('completed approval replay changes neither records, audit, nor approval time', async () => {
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue({ ...source, status: 'COMPLETE' }),
        update: vi.fn(),
      },
      prospectOutreachCampaign: { upsert: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    expect(
      await approveProspectStagingPackageCommitAction(
        { importId: source.id, actor },
        client as never,
      ),
    ).toMatchObject({ status: 'COMPLETE', campaignId: null, replayed: true })
    expect(tx.prospectImport.update).not.toHaveBeenCalled()
    expect(tx.prospectOutreachCampaign.upsert).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects missing source records instead of silently finalizing a smaller import', async () => {
    const tx = {
      prospectImport: { findUnique: vi.fn().mockResolvedValue(source), update: vi.fn() },
      prospectImportSourceRecord: { groupBy: vi.fn().mockResolvedValue([]) },
    }
    await expect(
      finalizeProspectStagingPackageAction({ importId: source.id }, {
        $transaction: (work: (tx: unknown) => unknown) => work(tx),
      } as never),
    ).rejects.toThrow('Source-record count mismatch')
    expect(tx.prospectImport.update).not.toHaveBeenCalled()
  })

  it('reconciles source rows separately from expanded contact/evidence records and leaves completed replay untouched', async () => {
    const rows = ['PROSPECT', 'CONTACT', 'EVIDENCE'].map((recordKind) => ({
      recordKind,
      processingStatus: 'COMPLETE',
      _count: { _all: 1 },
    }))
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue({ ...source, status: 'PROCESSING' }),
        update: vi.fn().mockResolvedValue({ status: 'COMPLETE' }),
      },
      prospectImportSourceRecord: {
        groupBy: vi.fn().mockResolvedValue(rows),
        findMany: vi.fn().mockResolvedValue([]),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    expect(
      await finalizeProspectStagingPackageAction({ importId: source.id }, client as never),
    ).toMatchObject({
      reconciliation: {
        total: 1,
        sourceRowsAccepted: 1,
        sourceRowsRejected: 0,
        sourceRowsSkipped: 0,
        sourceRecords: 3,
        imported: 3,
      },
    })
    expect(tx.prospectImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ importedRows: 1, failedRows: 0 }),
      }),
    )
    tx.prospectImport.update.mockClear()
    tx.prospectImport.findUnique.mockResolvedValue({ ...source, status: 'COMPLETE' })
    expect(
      await finalizeProspectStagingPackageAction({ importId: source.id }, client as never),
    ).toMatchObject({ replayed: true })
    expect(tx.prospectImport.update).not.toHaveBeenCalled()
  })
})

const now = new Date('2026-09-21T00:00:00Z')
function mappingFixture(kind: string, normalizedPayload: Record<string, unknown>) {
  const record = {
    id: 'source-record-1',
    importId: source.id,
    import: source,
    externalRecordId: `${kind.toLowerCase()}-stable`,
    recordKind: kind,
    sourceWorkbookHash: source.sourceWorkbookHash,
    parentExternalId: kind === 'PROSPECT' ? null : 'prospect-stable',
    rawPayload: {
      owner_name: 'An owner, not a contact',
      _source: { sheetName: 'Territory A', originalRowNumber: 2 },
    },
    normalizedPayload,
    claimToken: 'token-1',
    claimOwner: 'worker-1',
    processingStatus: 'PROCESSING',
    claimExpiresAt: new Date('2026-09-21T00:10:00Z'),
  }
  const tx = {
    prospectImportSourceRecord: {
      findUnique: vi.fn().mockResolvedValue(record),
      findFirst: vi.fn().mockResolvedValue({
        processingStatus: 'COMPLETE',
        canonicalOrganizationId: 'org-1',
        canonicalVenueId: 'venue-1',
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prospectTerritory: { upsert: vi.fn() },
    prospectOrganization: { upsert: vi.fn() },
    prospectOpportunity: { upsert: vi.fn() },
    prospectVenue: { upsert: vi.fn() },
    prospectContact: { upsert: vi.fn() },
    prospectSourceEvidence: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
  }
  const client = {
    $transaction: vi.fn((work) => work(tx)),
    prospectImportSourceRecord: {
      findMany: vi.fn().mockResolvedValue([record]),
      updateMany: vi.fn(),
    },
  }
  const commit = () =>
    commitProspectStagingPackageClaimAction(
      { claimToken: 'token-1', workerId: 'worker-1', now },
      client as never,
    )
  return { tx, commit }
}

describe('native source-only canonical mapping', () => {
  it('uses repeatable prospect/territory IDs and empty updates rather than overwriting curated state', async () => {
    const { tx, commit } = mappingFixture('PROSPECT', {
      organizationName: 'Museum',
      venueName: 'Museum',
      city: 'Chicago',
      region: 'IL',
      territory: 'Territory A',
      website: 'https://shared.example',
      fitAttributes: {},
    })
    expect(await commit()).toMatchObject({ processed: 1, failed: 0 })
    expect(await commit()).toMatchObject({ processed: 1, failed: 0 })
    for (const helper of [
      tx.prospectOrganization,
      tx.prospectVenue,
      tx.prospectTerritory,
      tx.prospectOpportunity,
    ]) {
      expect(helper.upsert).toHaveBeenCalledTimes(2)
      expect(helper.upsert.mock.calls[0]![0].where).toEqual(helper.upsert.mock.calls[1]![0].where)
      expect(helper.upsert.mock.calls[0]![0].update).toEqual({})
    }
    expect(tx.prospectVenue.upsert.mock.calls[0]![0].create.fitAttributes).toEqual({})
  })

  it('keeps a general inbox unnamed, with UNKNOWN readiness/permission and source-role provenance', async () => {
    const { tx, commit } = mappingFixture('CONTACT', {
      email: 'info@museum.example',
      sourceRole: 'GENERAL_CHANNEL_RECORDED',
    })
    expect(await commit()).toMatchObject({ processed: 1, failed: 0 })
    expect(tx.prospectContact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          fullName: null,
          email: 'info@museum.example',
          emailReadiness: 'UNKNOWN',
          permissionState: 'UNKNOWN',
          provenance: [
            {
              importId: source.id,
              externalRecordId: 'contact-stable',
              sourceRole: 'GENERAL_CHANNEL_RECORDED',
              verification: 'UNKNOWN',
            },
          ],
        }),
        update: {},
      }),
    )
  })

  it('retains title-only contacts without invented email or owner-name substitution', async () => {
    const { tx, commit } = mappingFixture('CONTACT', { title: 'Director' })
    expect(await commit()).toMatchObject({ processed: 1, failed: 0 })
    expect(tx.prospectContact.upsert.mock.calls[0]![0].create).toMatchObject({
      fullName: null,
      email: null,
      title: 'Director',
      permissionState: 'UNKNOWN',
    })
  })

  it('retains missing-URL workbook evidence and never overwrites an existing evidence record', async () => {
    const { tx, commit } = mappingFixture('EVIDENCE', {
      sourceType: 'WORKBOOK',
      label: 'Territory A row 2',
    })
    expect(await commit()).toMatchObject({ processed: 1, failed: 0 })
    expect(tx.prospectSourceEvidence.create.mock.calls[0]![0].data).toMatchObject({
      sourceType: 'WORKBOOK',
      sourceUrl: null,
      researchedAt: null,
      capturedValue: { raw: { _source: { sheetName: 'Territory A', originalRowNumber: 2 } } },
    })
    tx.prospectSourceEvidence.create.mockClear()
    tx.prospectSourceEvidence.findUnique.mockResolvedValue({ id: 'retained-evidence' } as never)
    expect(await commit()).toMatchObject({ processed: 1, failed: 0 })
    expect(tx.prospectSourceEvidence.create).not.toHaveBeenCalled()
  })
})

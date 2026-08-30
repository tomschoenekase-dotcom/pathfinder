import { describe, expect, it, vi } from 'vitest'

import {
  claimProspectStagingPackageRecordsAction,
  finalizeProspectStagingPackageAction,
} from './prospect-package-commit-actions'

describe('staging package commit state', () => {
  it('reclaims expired records with one bounded token and returns only records it won', async () => {
    const claimedRecords = [{ id: 'record-1', externalRecordId: 'prospect-1' }]
    const tx = {
      prospectImport: { findUnique: vi.fn().mockResolvedValue({ status: 'PROCESSING' }) },
      prospectImportSourceRecord: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'record-1' }])
          .mockResolvedValueOnce(claimedRecords),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    const now = new Date('2026-08-22T16:00:00.000Z')
    const result = await claimProspectStagingPackageRecordsAction(
      { importId: 'import-1', workerId: 'worker-1', limit: 250, now },
      client as never,
    )
    expect(result).toMatchObject({ recordKind: 'PROSPECT', records: claimedRecords })
    expect(tx.prospectImportSourceRecord.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 250,
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { processingStatus: 'PROCESSING', claimExpiresAt: { lt: now } },
          ]),
        }),
      }),
    )
    expect(tx.prospectImportSourceRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingStatus: 'PROCESSING',
          claimOwner: 'worker-1',
        }),
      }),
    )
  })

  it('finalizes exact reconciliation only after every source record is terminal', async () => {
    const rows = [
      { recordKind: 'PROSPECT', processingStatus: 'COMPLETE', _count: { _all: 20_000 } },
      { recordKind: 'DRAFT', processingStatus: 'QUARANTINED', _count: { _all: 2 } },
    ]
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'import-1',
          status: 'PROCESSING',
          totalRows: 20_000,
        }),
        update: vi.fn().mockResolvedValue({ status: 'PARTIAL' }),
      },
      prospectImportSourceRecord: {
        groupBy: vi.fn().mockResolvedValue(rows),
        findMany: vi.fn().mockResolvedValue([
          {
            recordKind: 'DRAFT',
            externalRecordId: 'draft-1',
            errorCode: 'CONFLICT',
            errorMessage: 'missing contact',
          },
        ]),
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      finalizeProspectStagingPackageAction(
        { importId: 'import-1', now: new Date('2026-08-22T16:00:00.000Z') },
        client as never,
      ),
    ).resolves.toMatchObject({
      finalized: true,
      status: 'PARTIAL',
      reconciliation: { imported: 20_000, failed: 2, truncatedErrors: true },
    })
  })
})

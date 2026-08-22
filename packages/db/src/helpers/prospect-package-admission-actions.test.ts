import { describe, expect, it, vi } from 'vitest'

import { admitProspectStagingPackageAction } from './prospect-package-admission-actions'

function stagingPackage(count = 1) {
  return {
    schema: 'torchiko.prospect-staging-package/v1',
    packageId: 'package-1',
    sourceSystem: 'HERMES_STAGING',
    createdAt: '2026-08-22T15:00:00.000Z',
    sourceWorkbook: { name: 'source.xlsx', sha256: 'a'.repeat(64), rowCount: count },
    lineage: { runId: 'run-1', promptVersion: 'prompt-v1', models: [] },
    counts: {
      PROSPECT: count,
      CONTACT: 0,
      EVIDENCE: 0,
      DRAFT: 0,
      DUPLICATE_REVIEW: 0,
      EXCEPTION: 0,
      RUN_LOG: 0,
    },
    records: Array.from({ length: count }, (_, index) => ({
      kind: 'PROSPECT',
      externalId: `prospect-${index}`,
      raw: { Name: `Museum ${index}` },
      normalized: { name: `Museum ${index}` },
      status: 'RESEARCHED',
    })),
  }
}

describe('prospect staging package admission', () => {
  it('persists immutable source identity without creating delivery records', async () => {
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'import-1' }),
      },
      prospectImportSourceRecord: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      prospectSendBatch: { create: vi.fn() },
      prospectSendOutbox: { create: vi.fn() },
      prospectEmailMessage: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      admitProspectStagingPackageAction(
        {
          package: stagingPackage(),
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        client as never,
      ),
    ).resolves.toMatchObject({ importId: 'import-1', sourceRecordCount: 1, replayed: false })
    expect(tx.prospectImportSourceRecord.createMany).toHaveBeenCalledTimes(1)
    expect(tx.prospectSendBatch.create).not.toHaveBeenCalled()
    expect(tx.prospectSendOutbox.create).not.toHaveBeenCalled()
    expect(tx.prospectEmailMessage.create).not.toHaveBeenCalled()
  })

  it('returns an exact replay without duplicating admitted records', async () => {
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'import-1',
          packageHash: expect.anything(),
          _count: { sourceRecords: 1 },
        }),
      },
      prospectImportSourceRecord: { createMany: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    const firstHashClient = {
      $transaction: vi.fn(async (work) => {
        const captureTx = {
          prospectImport: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockImplementation(({ data }) => ({ id: 'import-1', ...data })),
          },
          prospectImportSourceRecord: { createMany: vi.fn() },
        }
        return work(captureTx)
      }),
    }
    const first = await admitProspectStagingPackageAction(
      {
        package: stagingPackage(),
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      },
      firstHashClient as never,
    )
    tx.prospectImport.findUnique.mockResolvedValue({
      id: 'import-1',
      packageHash: first.packageHash,
      _count: { sourceRecords: 1 },
    })
    await expect(
      admitProspectStagingPackageAction(
        {
          package: stagingPackage(),
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        client as never,
      ),
    ).resolves.toMatchObject({ importId: 'import-1', replayed: true })
    expect(tx.prospectImportSourceRecord.createMany).not.toHaveBeenCalled()
  })

  it('bounds a 20,000-record admission into deterministic 500-row writes', async () => {
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'import-20k' }),
      },
      prospectImportSourceRecord: { createMany: vi.fn().mockResolvedValue({ count: 500 }) },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    const result = await admitProspectStagingPackageAction(
      {
        package: stagingPackage(20_000),
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      },
      client as never,
    )
    expect(result.sourceRecordCount).toBe(20_000)
    expect(tx.prospectImportSourceRecord.createMany).toHaveBeenCalledTimes(40)
    expect(
      tx.prospectImportSourceRecord.createMany.mock.calls.every(
        ([argument]) => argument.data.length === 500,
      ),
    ).toBe(true)
  }, 15_000)
})

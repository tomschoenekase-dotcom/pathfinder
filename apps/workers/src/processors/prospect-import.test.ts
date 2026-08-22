import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  commit: vi.fn(),
  claimPackage: vi.fn(),
  commitPackage: vi.fn(),
  finalizePackage: vi.fn(),
  publish: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: { prospectImport: { findUnique: mocks.findUnique } },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  commitProspectImportBatchAction: mocks.commit,
  claimProspectStagingPackageRecordsAction: mocks.claimPackage,
  commitProspectStagingPackageClaimAction: mocks.commitPackage,
  finalizeProspectStagingPackageAction: mocks.finalizePackage,
  publishCrmOperationalSignal: mocks.publish,
}))

import { processProspectImportCommitJob } from './prospect-import'

describe('prospect import worker', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reloads human approval and continues durable batches until complete', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'import-1', status: 'APPROVED', approvedBy: 'tom' })
    mocks.commit
      .mockResolvedValueOnce({
        processed: 100,
        failed: 0,
        done: false,
        prospectImport: { status: 'PROCESSING' },
      })
      .mockResolvedValueOnce({
        processed: 37,
        failed: 1,
        done: true,
        prospectImport: { status: 'PARTIAL' },
      })

    await expect(processProspectImportCommitJob({ importId: 'import-1' })).resolves.toEqual({
      batches: 2,
      processed: 137,
      failed: 1,
      status: 'PARTIAL',
    })
    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: 'HUMAN', id: 'tom', role: 'PLATFORM_ADMIN' } }),
    )
  })

  it('fails closed when approval identity is absent', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'import-1', status: 'APPROVED', approvedBy: null })
    await expect(processProspectImportCommitJob({ importId: 'import-1' })).rejects.toThrow(
      'human approval',
    )
  })

  it('surfaces a no-progress state for reconciliation instead of spinning', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'import-1', status: 'PROCESSING', approvedBy: 'tom' })
    mocks.commit.mockResolvedValue({
      processed: 0,
      failed: 0,
      done: false,
      prospectImport: { status: 'PROCESSING' },
    })
    await expect(processProspectImportCommitJob({ importId: 'import-1' })).rejects.toThrow(
      'made no progress',
    )
  })

  it('processes a synthetic 20k staging package in bounded durable claims', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'import-20k',
      status: 'PROCESSING',
      approvedBy: 'tom',
      fileType: 'torchiko-prospect-staging-package-v1',
    })
    let claims = 0
    mocks.claimPackage.mockImplementation(() =>
      claims++ < 80
        ? { claimToken: `00000000-0000-4000-8000-${claims.toString().padStart(12, '0')}` }
        : null,
    )
    mocks.commitPackage.mockResolvedValue({ processed: 250, failed: 0 })
    mocks.finalizePackage.mockResolvedValue({ finalized: true, unfinished: 0, status: 'COMPLETE' })

    await expect(processProspectImportCommitJob({ importId: 'import-20k' })).resolves.toEqual({
      batches: 80,
      processed: 20_000,
      failed: 0,
      status: 'COMPLETE',
    })
    expect(mocks.claimPackage).toHaveBeenCalledTimes(81)
    expect(mocks.commitPackage).toHaveBeenCalledTimes(80)
  })

  it('retries a reclaimed staging claim after an injected worker crash', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'import-1',
      status: 'PROCESSING',
      approvedBy: 'tom',
      fileType: 'torchiko-prospect-staging-package-v1',
    })
    const claim = { claimToken: '00000000-0000-4000-8000-000000000001' }
    mocks.claimPackage.mockResolvedValueOnce(claim)
    mocks.commitPackage.mockRejectedValueOnce(new Error('injected worker crash'))
    await expect(processProspectImportCommitJob({ importId: 'import-1' })).rejects.toThrow(
      'injected worker crash',
    )

    mocks.claimPackage.mockReset()
    mocks.commitPackage.mockReset()
    mocks.claimPackage.mockResolvedValueOnce(claim).mockResolvedValueOnce(null)
    mocks.commitPackage.mockResolvedValueOnce({ processed: 250, failed: 0 })
    mocks.finalizePackage.mockResolvedValueOnce({
      finalized: true,
      unfinished: 0,
      status: 'COMPLETE',
    })
    await expect(processProspectImportCommitJob({ importId: 'import-1' })).resolves.toEqual({
      batches: 1,
      processed: 250,
      failed: 0,
      status: 'COMPLETE',
    })
  })
})

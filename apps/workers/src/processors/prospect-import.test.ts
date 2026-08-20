import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  commit: vi.fn(),
  publish: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: { prospectImport: { findUnique: mocks.findUnique } },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  commitProspectImportBatchAction: mocks.commit,
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
})

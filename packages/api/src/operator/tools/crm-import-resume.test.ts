import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureProspectImportMappingAction,
  resumeIncompleteProspectImportDryRunAction,
} from '@pathfinder/db'
import type { OperatorCallContext } from '../registry'
import { resumeImport } from './crm-import-resume'
vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resumeIncompleteProspectImportDryRunAction: vi.fn(),
  configureProspectImportMappingAction: vi.fn(),
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueProspectImportStaging: vi.fn() }))

const input = { importId: 'import-1', fileHash: 'a'.repeat(64), mappingHash: 'b'.repeat(64) }
const row = {
  id: input.importId,
  status: 'DRAFT',
  fileHash: input.fileHash,
  mappingHash: input.mappingHash,
  jobClaimExpiresAt: null,
}
function context(overrides = {}) {
  return {
    grant: { allTenants: true, userId: 'owner' },
    config: { allowedUserIds: new Set(['owner']) },
    database: {
      prospectImportSheet: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ sheetName: 'Data', columns: ['Venue', 'Research'] }]),
      },
      prospectImport: { findUnique: vi.fn().mockResolvedValue({ ...row, ...overrides }) },
    },
  } as unknown as OperatorCallContext
}
describe('MCP source import resume', () => {
  beforeEach(() => vi.clearAllMocks())
  it('uses the canonical resume gate before enqueueing and returns the exact job ID', async () => {
    const enqueue = vi.fn().mockResolvedValue('source-job-1')
    expect(await resumeImport(input, context(), enqueue)).toEqual({
      importId: 'import-1',
      queued: true,
      jobId: 'source-job-1',
      state: 'QUEUED',
    })
    expect(resumeIncompleteProspectImportDryRunAction).toHaveBeenCalledOnce()
  })
  it('maps inspected source columns before resuming, and refuses unknown mapping targets', async () => {
    const enqueue = vi.fn().mockResolvedValue('mapped-job')
    await resumeImport(
      { ...input, mapping: { venueName: 'Venue', notes: 'Research' }, selectedSheets: ['Data'] },
      context(),
      enqueue,
    )
    expect(configureProspectImportMappingAction).toHaveBeenCalledWith(
      expect.objectContaining({
        importId: 'import-1',
        expectedFileHash: input.fileHash,
        expectedMappingHash: input.mappingHash,
        mapping: { venueName: 'Venue', notes: 'Research' },
        selectedSheets: ['Data'],
      }),
      expect.anything(),
    )
    await expect(
      resumeImport(
        { ...input, mapping: { venueName: 'Missing' }, selectedSheets: ['Data'] },
        context(),
        enqueue,
      ),
    ).rejects.toMatchObject({ code: 'ARGS_HASH_MISMATCH' })
    await expect(
      resumeImport(
        {
          ...input,
          mapping: { venueName: 'Venue', unauthorized: 'Research' },
          selectedSheets: ['Data'],
        },
        context(),
        enqueue,
      ),
    ).rejects.toMatchObject({ code: 'ARGS_HASH_MISMATCH' })
    expect(enqueue).toHaveBeenCalledOnce()
  })
  it('refuses narrowed grants and changed hashes without enqueueing', async () => {
    const limited = context()
    Object.assign(limited.grant, { allTenants: false })
    const enqueue = vi.fn()
    await expect(resumeImport(input, limited, enqueue)).rejects.toMatchObject({
      code: 'FORBIDDEN_ACTOR',
    })
    await expect(
      resumeImport(input, context({ mappingHash: 'c'.repeat(64) }), enqueue),
    ).rejects.toMatchObject({ code: 'ARGS_HASH_MISMATCH' })
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('does not reset an active worker and does not enqueue after canonical refusal', async () => {
    const enqueue = vi.fn()
    expect(
      await resumeImport(
        input,
        context({ jobClaimExpiresAt: new Date(Date.now() + 60_000) }),
        enqueue,
      ),
    ).toMatchObject({ queued: false, state: 'RUNNING' })
    expect(resumeIncompleteProspectImportDryRunAction).not.toHaveBeenCalled()
    vi.mocked(resumeIncompleteProspectImportDryRunAction).mockRejectedValueOnce(
      new Error('not resumable'),
    )
    await expect(resumeImport(input, context(), enqueue)).rejects.toThrow('not resumable')
    expect(enqueue).not.toHaveBeenCalled()
  })
})

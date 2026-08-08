import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  mkdtemp: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdateMany: vi.fn(),
  rm: vi.fn(),
  updateJobRecord: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: mocks.mkdtemp, rm: mocks.rm }
})
vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  db: {
    mediaIngestionProject: {
      findFirst: mocks.projectFindFirst,
      updateMany: mocks.projectUpdateMany,
    },
  },
  updateJobRecord: mocks.updateJobRecord,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
}))
vi.mock('@pathfinder/jobs', () => ({
  MEDIA_INGESTION_PROCESS_JOB: 'media-ingestion-process',
  MEDIA_INGESTION_QUEUE: 'test-media-ingestion',
}))

import { cleanupMediaWorkDir, processMediaIngestionJob } from './media-ingestion'

const payload = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  projectId: 'project_1',
  uploadAttemptId: '11111111-1111-4111-8111-111111111111',
}
const project = {
  id: 'project_1',
  context: 'Context',
  mode: 'BALANCED',
  settings: {},
  sourceObjectKey: 'test/project.zip',
  status: 'QUEUED',
  uploadAttemptId: payload.uploadAttemptId,
  venue: { name: 'Test Venue' },
}

describe('media ingestion lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
  })

  it('treats a stale generation as complete without claiming or starting provider work', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      ...project,
      uploadAttemptId: '22222222-2222-4222-8222-222222222222',
    })

    await expect(processMediaIngestionJob(payload, 'bull_stale')).resolves.toBeUndefined()

    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('record_1', { status: 'COMPLETE' })
  })

  it('claims a retained legacy payload only against the null generation', async () => {
    const legacyPayload = {
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      projectId: payload.projectId,
    } as unknown as Parameters<typeof processMediaIngestionJob>[0]
    mocks.projectFindFirst.mockResolvedValueOnce({ ...project, uploadAttemptId: null })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(processMediaIngestionJob(legacyPayload, 'bull_legacy')).resolves.toBeUndefined()

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        uploadAttemptId: null,
        status: { in: ['QUEUED', 'FAILED'] },
      },
      data: { status: 'INVENTORYING', stage: 'inventory', progress: 3, error: null },
    })
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
  })

  it('does not let a retained legacy payload claim a newer non-null generation', async () => {
    const legacyPayload = {
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      projectId: payload.projectId,
    } as unknown as Parameters<typeof processMediaIngestionJob>[0]
    mocks.projectFindFirst.mockResolvedValueOnce(project)

    await expect(processMediaIngestionJob(legacyPayload, 'bull_legacy')).resolves.toBeUndefined()

    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('record_1', { status: 'COMPLETE' })
  })

  it('scopes a legacy failure write to null so a new generation wins the race', async () => {
    const legacyPayload = {
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      projectId: payload.projectId,
    } as unknown as Parameters<typeof processMediaIngestionJob>[0]
    mocks.projectFindFirst.mockResolvedValueOnce({ ...project, uploadAttemptId: null })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    mocks.mkdtemp.mockRejectedValueOnce(new Error('temp unavailable'))

    await expect(processMediaIngestionJob(legacyPayload, 'bull_legacy')).rejects.toThrow(
      'temp unavailable',
    )

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'project_1', tenantId: 'tenant_1', uploadAttemptId: null },
      data: { status: 'FAILED', error: 'temp unavailable' },
    })
  })

  it('completes a duplicate delivery without provider or temp work when claim is unavailable', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(project)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(processMediaIngestionJob(payload, 'bull_1')).resolves.toBeUndefined()

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        uploadAttemptId: payload.uploadAttemptId,
        status: { in: ['QUEUED', 'FAILED'] },
      },
      data: { status: 'INVENTORYING', stage: 'inventory', progress: 3, error: null },
    })
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('record_1', { status: 'COMPLETE' })
  })

  it('marks project and job FAILED when temp-directory creation fails after claim', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(project)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.mkdtemp.mockRejectedValueOnce(new Error('temp unavailable'))

    await expect(processMediaIngestionJob(payload, 'bull_1')).rejects.toThrow('temp unavailable')

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        uploadAttemptId: payload.uploadAttemptId,
      },
      data: { status: 'FAILED', error: 'temp unavailable' },
    })
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('record_1', {
      status: 'FAILED',
      error: 'temp unavailable',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
    })
    expect(mocks.rm).not.toHaveBeenCalled()
  })

  it('allows a Bull retry to reclaim FAILED only for the same generation', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({ ...project, status: 'FAILED' })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.mkdtemp.mockRejectedValueOnce(new Error('temp unavailable'))

    await expect(processMediaIngestionJob(payload, 'bull_retry')).rejects.toThrow(
      'temp unavailable',
    )

    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        uploadAttemptId: payload.uploadAttemptId,
        status: { in: ['QUEUED', 'FAILED'] },
      },
      data: { status: 'INVENTORYING', stage: 'inventory', progress: 3, error: null },
    })
    expect(mocks.mkdtemp).toHaveBeenCalledOnce()
  })

  it('logs and absorbs cleanup failure so it cannot mask the primary outcome', async () => {
    mocks.rm.mockRejectedValueOnce(new Error('file busy'))
    await expect(cleanupMediaWorkDir('C:/temp/project', 'project_1')).resolves.toBeUndefined()
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.cleanup.failed',
      projectId: 'project_1',
      error: 'file busy',
    })
  })
})

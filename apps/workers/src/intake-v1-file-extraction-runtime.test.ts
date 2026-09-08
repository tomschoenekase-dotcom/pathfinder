import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ process: vi.fn(), reconcile: vi.fn(), enabled: true }))

vi.mock('@pathfinder/config', () => ({ isFeatureEnabled: () => mocks.enabled }))
vi.mock('@pathfinder/jobs', () => ({
  INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB: 'intake-v1-file-extraction-process',
  INTAKE_V1_FILE_EXTRACTION_QUEUE: 'test-intake-v1-file-extraction',
  INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB: 'intake-v1-file-extraction-recovery',
  checkBullMQConnection: vi.fn(),
  closeBullMQConnection: vi.fn(),
  closeJobQueues: vi.fn(),
  getBullMQConnection: vi.fn(),
}))
vi.mock('./lib/job-execution', () => ({ queueSafeJobProcessor: vi.fn() }))
vi.mock('./lib/isolated-runtime-readiness', () => ({
  startIsolatedRuntimeReadinessHeartbeat: vi.fn(),
}))
vi.mock('./processors/intake-v1-file-extraction', () => ({
  processIntakeV1FileExtractionJob: mocks.process,
  reconcileIntakeV1FileExtractionJobs: mocks.reconcile,
}))

import {
  createIntakeV1FileExtractionResources,
  handleIntakeV1FileExtraction,
  startIntakeV1FileExtractionRuntime,
} from './intake-v1-file-extraction-runtime'

describe('V1 file extraction runtime queue boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.enabled = true
  })

  it('passes only an opaque dispatch identity to the enabled processor', async () => {
    await handleIntakeV1FileExtraction({
      name: 'intake-v1-file-extraction-process',
      data: { dispatchId: 'dispatch_1' },
      id: '1',
    } as never)
    expect(mocks.process).toHaveBeenCalledWith(
      { dispatchId: 'dispatch_1' },
      expect.stringMatching(/^intake-v1-file:\d+:1$/u),
    )
  })

  it('runs recovery and rejects unknown job names', async () => {
    await handleIntakeV1FileExtraction({
      name: 'intake-v1-file-extraction-recovery',
      data: {},
    } as never)
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    await expect(
      handleIntakeV1FileExtraction({ name: 'unknown', data: {} } as never),
    ).rejects.toThrow('Unsupported intake V1 file extraction job: unknown')
  })

  it('does no queue work or connection work while disabled', async () => {
    mocks.enabled = false
    await expect(
      handleIntakeV1FileExtraction({
        name: 'intake-v1-file-extraction-process',
        data: { dispatchId: 'dispatch_1' },
      } as never),
    ).resolves.toBe('disabled')
    expect(mocks.process).not.toHaveBeenCalled()
    await expect(createIntakeV1FileExtractionResources()).rejects.toThrow(
      'Intake V1 file extraction worker is disabled.',
    )
    await expect(startIntakeV1FileExtractionRuntime()).rejects.toThrow(
      'Intake V1 file extraction worker is disabled.',
    )
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  reconcile: vi.fn(),
  enabled: true,
}))

vi.mock('@pathfinder/config', () => ({
  isFeatureEnabled: () => mocks.enabled,
}))

vi.mock('@pathfinder/jobs', () => ({
  INTAKE_V1_SOURCE_PROCESSING_PROCESS_JOB: 'intake-v1-source-processing-process',
  INTAKE_V1_SOURCE_PROCESSING_QUEUE: 'test-intake-v1-source-processing',
  INTAKE_V1_SOURCE_PROCESSING_RECOVERY_JOB: 'intake-v1-source-processing-recovery',
  checkBullMQConnection: vi.fn(),
  closeBullMQConnection: vi.fn(),
  closeJobQueues: vi.fn(),
  getBullMQConnection: vi.fn(),
}))
vi.mock('./lib/job-execution', () => ({ queueSafeJobProcessor: vi.fn() }))
vi.mock('./lib/isolated-runtime-readiness', () => ({
  startIsolatedRuntimeReadinessHeartbeat: vi.fn(),
}))
vi.mock('./processors/intake-v1-source-processing', () => ({
  processIntakeV1SourceProcessingJob: mocks.process,
  reconcileIntakeV1SourceProcessingJobs: mocks.reconcile,
}))

import {
  createIntakeV1WebsiteResearchResources,
  handleIntakeV1WebsiteResearch,
  startIntakeV1WebsiteResearchRuntime,
} from './intake-v1-website-research-runtime'

describe('V1 website research runtime queue boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.enabled = true
  })

  it('passes only opaque dispatch work through the explicitly enabled processor', async () => {
    const job = {
      name: 'intake-v1-source-processing-process',
      data: { dispatchId: 'dispatch_1' },
      id: '1',
    }
    await handleIntakeV1WebsiteResearch(job as never)
    expect(mocks.process).toHaveBeenCalledWith(
      { dispatchId: 'dispatch_1' },
      expect.stringMatching(/^intake-v1-research:\d+:1$/u),
      undefined,
    )
  })

  it('runs the bounded recovery path with the same explicit gate', async () => {
    await handleIntakeV1WebsiteResearch({
      name: 'intake-v1-source-processing-recovery',
      data: {},
    } as never)
    expect(mocks.reconcile).toHaveBeenCalledWith()
    expect(mocks.process).not.toHaveBeenCalled()
  })

  it('fails closed for an unknown queue job name', async () => {
    await expect(
      handleIntakeV1WebsiteResearch({ name: 'unknown', data: {} } as never),
    ).rejects.toThrow('Unsupported intake V1 source processing job: unknown')
  })

  it('rejects an unknown queue job even while the central gate is closed', async () => {
    mocks.enabled = false
    await expect(
      handleIntakeV1WebsiteResearch({ name: 'unknown', data: {} } as never),
    ).rejects.toThrow('Unsupported intake V1 source processing job: unknown')
    expect(mocks.process).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  it('does not delegate an actual queue delivery when the central gate closes', async () => {
    mocks.enabled = false
    await expect(
      handleIntakeV1WebsiteResearch({
        name: 'intake-v1-source-processing-process',
        data: { dispatchId: 'dispatch_1' },
      } as never),
    ).resolves.toBe('disabled')
    expect(mocks.process).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  it('rejects direct resource creation and startup before any Redis connection when disabled', async () => {
    mocks.enabled = false
    await expect(createIntakeV1WebsiteResearchResources()).rejects.toThrow(
      'Intake V1 website research worker is disabled.',
    )
    await expect(startIntakeV1WebsiteResearchRuntime()).rejects.toThrow(
      'Intake V1 website research worker is disabled.',
    )
  })
})

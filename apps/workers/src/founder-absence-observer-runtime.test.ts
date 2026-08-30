import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readReadiness: vi.fn(),
  capture: vi.fn(),
  releaseSha: 'a'.repeat(40),
}))

vi.mock('@pathfinder/config/release-identity', () => ({
  resolveReleaseRevision: () => mocks.releaseSha,
}))

vi.mock('@pathfinder/api/founder-absence-observation', () => ({
  readFounderAbsenceCurrentReadiness: mocks.readReadiness,
  captureFounderAbsenceObservation: mocks.capture,
}))

import {
  captureCurrentFounderAbsenceObservation,
  startFounderAbsenceObserver,
} from './founder-absence-observer-runtime'

describe('founder absence observer runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mocks.readReadiness.mockResolvedValue({ summary: {}, dimensions: [], evidenceWindow: {} })
    mocks.capture.mockResolvedValue({
      id: 'observation_1',
      observedOn: new Date('2026-08-28T00:00:00.000Z'),
      releaseSha: mocks.releaseSha,
      evidenceComplete: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('captures one exact-revision sample immediately', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z')

    await captureCurrentFounderAbsenceObservation(now)

    expect(mocks.readReadiness).toHaveBeenCalledWith(now)
    expect(mocks.capture).toHaveBeenCalledWith({
      readiness: expect.any(Object),
      releaseSha: mocks.releaseSha,
      now,
    })
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('workers.founder-absence-observation.retained'),
    )
  })

  it('retries on the bounded interval and stops cleanly', async () => {
    const runtime = await startFounderAbsenceObserver()
    expect(mocks.capture).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(runtime.intervalMs)
    expect(mocks.capture).toHaveBeenCalledTimes(2)

    await runtime.shutdown()
    await vi.advanceTimersByTimeAsync(runtime.intervalMs)
    expect(mocks.capture).toHaveBeenCalledTimes(2)
  })

  it('reports interval failures without writing exception text', async () => {
    const runtime = await startFounderAbsenceObserver()
    mocks.capture.mockRejectedValueOnce(new Error('redis://user:secret@private-host'))

    await vi.advanceTimersByTimeAsync(runtime.intervalMs)

    expect(process.stderr.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        action: 'workers.founder-absence-observation.failed',
        errorCode: 'observation-capture-failed',
      })}\n`,
    )
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('secret'))
    await runtime.shutdown()
  })
})

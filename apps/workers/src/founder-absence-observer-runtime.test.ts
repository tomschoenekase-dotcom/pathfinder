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

  it('serializes interval captures and drains the active capture during shutdown', async () => {
    const runtime = await startFounderAbsenceObserver()
    let resolveCapture: ((value: unknown) => void) | undefined
    mocks.capture.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCapture = resolve
      }),
    )

    await vi.advanceTimersByTimeAsync(runtime.intervalMs)
    expect(mocks.capture).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(runtime.intervalMs)
    expect(mocks.capture).toHaveBeenCalledTimes(2)

    let shutdownComplete = false
    const shutdown = runtime.shutdown().then(() => {
      shutdownComplete = true
    })
    await Promise.resolve()
    expect(shutdownComplete).toBe(false)

    resolveCapture?.({
      id: 'observation_2',
      observedOn: new Date('2026-08-28T00:30:00.000Z'),
      releaseSha: mocks.releaseSha,
      evidenceComplete: true,
    })
    await shutdown
    expect(shutdownComplete).toBe(true)

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

  it('contains diagnostic write failures from interval capture errors', async () => {
    const runtime = await startFounderAbsenceObserver()
    mocks.capture.mockRejectedValueOnce(new Error('capture unavailable'))
    vi.mocked(process.stderr.write).mockImplementationOnce(() => {
      throw new Error('stderr unavailable')
    })

    await vi.advanceTimersByTimeAsync(runtime.intervalMs)
    await expect(runtime.shutdown()).resolves.toBeUndefined()
  })
})

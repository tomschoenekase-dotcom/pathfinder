import { describe, expect, it, vi } from 'vitest'
import { UnrecoverableError } from 'bullmq'

import {
  assertMediaJobActive,
  cancelAllMediaJobsAfterWorkerError,
  cancelMediaJobsAfterLockRenewalFailure,
  MediaAttemptDeadlineExceededError,
  MediaJobCancelledError,
  normalizeMediaJobError,
} from './media-job-cancellation'

describe('media job cancellation', () => {
  it('throws a stable cancellation error only after abort', () => {
    const controller = new AbortController()
    expect(() => assertMediaJobActive(controller.signal)).not.toThrow()
    controller.abort()
    expect(() => assertMediaJobActive(controller.signal)).toThrow(MediaJobCancelledError)
  })

  it('preserves a typed deadline reason instead of mislabeling it as lock loss', () => {
    const controller = new AbortController()
    const deadline = new MediaAttemptDeadlineExceededError(1000)
    controller.abort(deadline)

    expect(() => assertMediaJobActive(controller.signal)).toThrow(deadline)
    expect(
      normalizeMediaJobError(new DOMException('aborted', 'AbortError'), controller.signal),
    ).toBe(deadline)
  })

  it('normalizes provider-specific abort errors after lock loss', () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      normalizeMediaJobError(new DOMException('provider abort', 'AbortError'), controller.signal),
    ).toBeInstanceOf(MediaJobCancelledError)
  })

  it('does not turn a deterministic unrecoverable failure into a retryable lock-loss error', () => {
    const controller = new AbortController()
    controller.abort()
    const deterministic = new UnrecoverableError('generated output crossed its limit')
    expect(normalizeMediaJobError(deterministic, controller.signal)).toBe(deterministic)
  })

  it('cancels only unique job IDs named by the lock-renewal failure', () => {
    const cancelJob = vi.fn((jobId: string) => jobId !== 'already-gone')
    expect(
      cancelMediaJobsAfterLockRenewalFailure({ cancelAllJobs: vi.fn(), cancelJob }, [
        'media-a',
        'media-a',
        'already-gone',
        'media-b',
      ]),
    ).toBe(2)
    expect(cancelJob.mock.calls).toEqual([['media-a'], ['already-gone'], ['media-b']])
  })

  it('cancels only jobs tracked by the media worker after an ownership-uncertain error', () => {
    const cancelAllJobs = vi.fn()
    cancelAllMediaJobsAfterWorkerError({ cancelAllJobs, cancelJob: vi.fn() })
    expect(cancelAllJobs).toHaveBeenCalledOnce()
  })
})

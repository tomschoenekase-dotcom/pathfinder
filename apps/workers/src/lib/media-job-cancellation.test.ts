import { describe, expect, it, vi } from 'vitest'

import {
  assertMediaJobActive,
  cancelAllMediaJobsAfterWorkerError,
  cancelMediaJobsAfterLockRenewalFailure,
  MediaJobCancelledError,
} from './media-job-cancellation'

describe('media job cancellation', () => {
  it('throws a stable cancellation error only after abort', () => {
    const controller = new AbortController()
    expect(() => assertMediaJobActive(controller.signal)).not.toThrow()
    controller.abort()
    expect(() => assertMediaJobActive(controller.signal)).toThrow(MediaJobCancelledError)
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

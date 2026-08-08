import { describe, expect, it, vi } from 'vitest'

import {
  createMediaAttemptSignal,
  MAX_MEDIA_GENERATED_OUTPUT_BYTES,
  MEDIA_ATTEMPT_DEADLINE_MS,
  MediaGeneratedOutputBudget,
  MediaGeneratedOutputLimitError,
} from './media-attempt-limits'
import { MediaAttemptDeadlineExceededError } from './media-job-cancellation'

describe('media attempt deadline', () => {
  it('aborts at the exact whole-attempt deadline and disposes idempotently', () => {
    vi.useFakeTimers()
    try {
      const attempt = createMediaAttemptSignal(undefined, 1000)
      vi.advanceTimersByTime(999)
      expect(attempt.signal.aborted).toBe(false)
      vi.advanceTimersByTime(1)
      expect(attempt.signal.reason).toBeInstanceOf(MediaAttemptDeadlineExceededError)
      expect(attempt.signal.reason).toMatchObject({ timeoutMs: 1000 })
      attempt.dispose()
      attempt.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps ownership loss as the first abort reason', () => {
    vi.useFakeTimers()
    try {
      const ownership = new AbortController()
      const attempt = createMediaAttemptSignal(ownership.signal, 1000)
      ownership.abort(new DOMException('lock lost', 'AbortError'))
      const reason = attempt.signal.reason
      vi.advanceTimersByTime(1000)
      expect(attempt.signal.reason).toBe(reason)
      attempt.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not extend an already-expired ownership signal', () => {
    const ownership = new AbortController()
    ownership.abort()
    const attempt = createMediaAttemptSignal(ownership.signal, 1000)
    expect(attempt.signal.aborted).toBe(true)
    attempt.dispose()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects an invalid attempt deadline: %s',
    (timeoutMs) => {
      expect(() => createMediaAttemptSignal(undefined, timeoutMs)).toThrow(/positive 32-bit/u)
    },
  )

  it('keeps the fail-safe deadline constant explicit', () => {
    expect(MEDIA_ATTEMPT_DEADLINE_MS).toBe(21_600_000)
  })
})

describe('media generated-output budget', () => {
  it('accepts the exact ceiling and rejects crossing without advancing', () => {
    const budget = new MediaGeneratedOutputBudget(5)
    budget.consume(2)
    budget.consume(3)
    expect(budget.bytes).toBe(5)
    expect(() => budget.consume(1)).toThrow(MediaGeneratedOutputLimitError)
    expect(budget.bytes).toBe(5)
  })

  it('aggregates output across producers without refund', () => {
    const budget = new MediaGeneratedOutputBudget(10)
    budget.consume(3)
    budget.consume(4)
    expect(budget.remainingBytes).toBe(3)
    expect(() => budget.consume(4)).toThrow(MediaGeneratedOutputLimitError)
  })

  it('rejects a crossing transform chunk before forwarding it', async () => {
    const budget = new MediaGeneratedOutputBudget(3)
    const transform = budget.createTransform()
    const forwarded: Buffer[] = []
    transform.on('data', (chunk: Buffer) => forwarded.push(chunk))
    transform.write(Buffer.from('abc'))
    const error = new Promise<Error>((resolve) => transform.once('error', resolve))
    transform.end(Buffer.from('d'))

    await expect(error).resolves.toBeInstanceOf(MediaGeneratedOutputLimitError)
    expect(Buffer.concat(forwarded).toString()).toBe('abc')
    expect(budget.bytes).toBe(3)
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects an invalid budget: %s', (maxBytes) => {
    expect(() => new MediaGeneratedOutputBudget(maxBytes)).toThrow(/positive safe integer/u)
  })

  it('keeps the aggregate generated-output fuse aligned with the source upload ceiling', () => {
    expect(MAX_MEDIA_GENERATED_OUTPUT_BYTES).toBe(5 * 1024 * 1024 * 1024)
  })
})

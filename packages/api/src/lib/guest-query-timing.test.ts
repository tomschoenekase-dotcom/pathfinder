import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureGuestQueryTiming,
  guestQueryTiming,
  guestQueryTimingAsync,
} from './guest-query-timing'

afterEach(() => vi.unstubAllEnvs())

describe('local guest query timing', () => {
  it('preserves returned identity and exact exceptions without a collector', async () => {
    const value = {}
    expect(guestQueryTiming('inactive', () => value)).toBe(value)
    const failure = new Error('original failure')
    expect(() =>
      guestQueryTiming('inactive', () => {
        throw failure
      }),
    ).toThrow(failure)
    await expect(
      guestQueryTimingAsync('inactive', async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })

  it('records nested accounting and failure while preserving values', async () => {
    const failure = new Error('original failure')
    const value = {}
    const result = await captureGuestQueryTiming(async () =>
      guestQueryTiming('parent', () => {
        expect(guestQueryTiming('child', () => value)).toBe(value)
        expect(() =>
          guestQueryTiming('failed-child', () => {
            throw failure
          }),
        ).toThrow(failure)
        return value
      }),
    )
    expect(result.value).toBe(value)
    const [parent, child, failed] = result.spans
    if (!parent || !child || !failed) throw new Error('Expected all three nested spans')
    expect(result.spans).toHaveLength(3)
    expect(parent.parentId).toBeNull()
    expect(child.parentId).toBe(parent.id)
    expect(failed.parentId).toBe(parent.id)
    expect(failed.outcome).toBe('THREW')
    expect(parent.selfMs + child.inclusiveMs + failed.inclusiveMs).toBeCloseTo(
      parent.inclusiveMs,
      8,
    )
    for (const span of result.spans) {
      expect(span.inclusiveMs).toBe(span.endMs - span.startMs)
      expect(span.selfMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('subtracts the union of overlapping async child intervals', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const result = await captureGuestQueryTiming(async () =>
      guestQueryTimingAsync('parent', async () => {
        const first = guestQueryTimingAsync('first', async () => {
          await gate
        })
        const second = guestQueryTimingAsync('second', async () => {
          release()
          await gate
        })
        await Promise.all([first, second])
      }),
    )
    const [parent, first, second] = result.spans
    if (!parent || !first || !second) throw new Error('Expected all three async spans')
    expect(result.spans).toHaveLength(3)
    expect(first.startMs).toBeLessThanOrEqual(second.startMs)
    expect(first.endMs).toBeGreaterThanOrEqual(second.startMs)
    const union = Math.max(first.endMs, second.endMs) - first.startMs
    expect(parent.selfMs).toBeCloseTo(parent.inclusiveMs - union, 8)
    expect(parent.selfMs).toBeGreaterThanOrEqual(0)
  })

  it('isolates concurrent captures and rejects production activation', async () => {
    const results = await Promise.all(
      ['one', 'two'].map((stage) =>
        captureGuestQueryTiming(async () =>
          guestQueryTimingAsync(stage, async () => {
            await Promise.resolve()
            return stage
          }),
        ),
      ),
    )
    expect(results.map((result) => result.spans.map((span) => span.stage))).toEqual([
      ['one'],
      ['two'],
    ])
    vi.stubEnv('NODE_ENV', 'production')
    await expect(captureGuestQueryTiming(async () => null)).rejects.toThrow('local only')
  })
})

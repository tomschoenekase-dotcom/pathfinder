import { beforeEach, describe, expect, it, vi } from 'vitest'

const { assertAvailable, loggerWarn } = vi.hoisted(() => ({
  assertAvailable: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  assertGlobalAiAvailable: assertAvailable,
  GlobalAiAdmissionError: class GlobalAiAdmissionError extends Error {
    code = 'global-ai-paused'
  },
}))

vi.mock('@pathfinder/config', () => ({
  logger: { warn: loggerWarn },
}))

import { GlobalAiAdmissionError } from '@pathfinder/db'

import {
  delayJobForGlobalAiPause,
  globalAiAdmissionAvailable,
  GLOBAL_AI_RECHECK_DELAY_MS,
  runAiJobWithIncidentControl,
} from './global-ai-deferral'

beforeEach(() => vi.resetAllMocks())

describe('worker global AI deferral', () => {
  it('allows work only after the platform control is readable and active', async () => {
    assertAvailable.mockResolvedValue(undefined)
    await expect(globalAiAdmissionAvailable()).resolves.toBe(true)
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  it('fails closed without exposing provider or database details', async () => {
    assertAvailable.mockRejectedValue(new Error('private database detail'))
    await expect(globalAiAdmissionAvailable()).resolves.toBe(false)
    expect(loggerWarn).toHaveBeenCalledWith({
      action: 'workers.global-ai.admission-denied',
      cause: 'control-unavailable',
    })
  })

  it('moves a retained job to the bounded recheck time and throws DelayedError', async () => {
    const moveToDelayed = vi.fn().mockResolvedValue(undefined)
    await expect(
      delayJobForGlobalAiPause({ moveToDelayed } as never, 'lock-token', 1_000),
    ).rejects.toMatchObject({ name: 'DelayedError' })
    expect(moveToDelayed).toHaveBeenCalledWith(1_000 + GLOBAL_AI_RECHECK_DELAY_MS, 'lock-token')
  })

  it('refuses to mutate a job without the BullMQ lock token', async () => {
    const moveToDelayed = vi.fn()
    await expect(delayJobForGlobalAiPause({ moveToDelayed } as never, undefined)).rejects.toThrow(
      'lock token',
    )
    expect(moveToDelayed).not.toHaveBeenCalled()
  })

  it('delays without consuming the retry path when admission closes during work', async () => {
    assertAvailable.mockResolvedValue(undefined)
    const moveToDelayed = vi.fn().mockResolvedValue(undefined)
    const admissionError = new GlobalAiAdmissionError('global-ai-paused')
    await expect(
      runAiJobWithIncidentControl({ moveToDelayed } as never, 'lock-token', async () => {
        throw admissionError
      }),
    ).rejects.toMatchObject({ name: 'DelayedError' })
    expect(moveToDelayed).toHaveBeenCalledTimes(1)
  })

  it('preserves a genuine processor failure even when the control closes concurrently', async () => {
    assertAvailable.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('db down'))
    const moveToDelayed = vi.fn().mockResolvedValue(undefined)
    await expect(
      runAiJobWithIncidentControl({ moveToDelayed } as never, 'lock-token', async () => {
        throw new Error('genuine provider failure')
      }),
    ).rejects.toThrow('genuine provider failure')
    expect(moveToDelayed).not.toHaveBeenCalled()
    expect(assertAvailable).toHaveBeenCalledTimes(1)
  })
})

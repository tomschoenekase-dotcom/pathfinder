import { describe, expect, it } from 'vitest'
import { inWorkerStartupPhase, workerStartupFailureEvent } from './worker-startup-diagnostic'

describe('bounded worker startup diagnostics', () => {
  it.each([
    'release-identity',
    'startup-policy',
    'required-environment',
    'redis-connectivity',
    'runtime-start',
  ] as const)(
    'identifies %s without retaining or serializing the underlying error',
    async (phase) => {
      const secret = 'synthetic-private-value-must-not-appear'
      const error = await inWorkerStartupPhase(phase, () => {
        throw new Error(secret)
      }).catch((caught: unknown) => caught)
      expect(workerStartupFailureEvent(error)).toEqual({
        action: 'workers.start.failed',
        errorCode: 'startup-rejected',
        phase,
      })
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(JSON.stringify(workerStartupFailureEvent(error))).not.toContain(secret)
      expect(String(error)).not.toContain(secret)
    },
  )

  it('preserves successful sync and async values without replacing the runtime owner', async () => {
    const runtime = { shutdown: async () => undefined }
    expect(await inWorkerStartupPhase('runtime-start', () => runtime)).toBe(runtime)
    expect(await inWorkerStartupPhase('runtime-start', async () => runtime)).toBe(runtime)
  })

  it('contains asynchronous and non-Error rejection values', async () => {
    const error = await inWorkerStartupPhase('redis-connectivity', async () => {
      throw { message: 'synthetic-private-value', phase: 'forged-phase' }
    }).catch((caught: unknown) => caught)
    expect(workerStartupFailureEvent(error).phase).toBe('redis-connectivity')
    expect(JSON.stringify(workerStartupFailureEvent(error))).not.toContain(
      'synthetic-private-value',
    )
  })

  it.each([undefined, null, 'private', { phase: 'release-identity' }, new Error('private')])(
    'does not trust arbitrary rejection objects',
    (error) => {
      expect(workerStartupFailureEvent(error)).toEqual({
        action: 'workers.start.failed',
        errorCode: 'startup-rejected',
        phase: 'runtime-start',
      })
    },
  )

  it('does not open the next startup boundary after rejection', async () => {
    let runtimeOpened = false
    await expect(
      (async () => {
        await inWorkerStartupPhase('release-identity', () => {
          throw new Error('staging-worker-release-identity-invalid')
        })
        runtimeOpened = true
      })(),
    ).rejects.toThrow('worker-startup-rejected')
    expect(runtimeOpened).toBe(false)
  })
})

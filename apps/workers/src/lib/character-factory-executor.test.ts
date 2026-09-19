import { describe, expect, it, vi } from 'vitest'

import { parseAgentBridgeRunnerConfig } from './agent-bridge-runner'
import { runCharacterFactoryExecutor } from './character-factory-executor'

const config = parseAgentBridgeRunnerConfig({
  endpoint: 'https://torchiko.test/bridge',
  secret: `pf_mcp_${'a'.repeat(43)}`,
  venueId: 'venue-a',
  provider: 'CODEX_SUBSCRIPTION',
  label: 'Provider-dark fixture',
  workdir: process.cwd(),
  workerKey: 'character-factory-unit-fixture',
  taskTimeoutMs: 10_000,
})
const completion = {
  requestId: 'request-a',
  resultPayload: { retained: true },
}
const leaseToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('explicit character factory executor', () => {
  it('claims one named request, renews its supported lease, and requires exact canonical success', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'claimCharacterFactoryJob')
        return { state: 'claimed', job: { requestId: 'request-a', venueId: 'venue-a', leaseToken } }
      if (method === 'heartbeatCharacterFactoryJob') return undefined
      if (method === 'completeCharacterFactoryJob')
        return {
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          requestId: 'request-a',
          status: 'SUCCEEDED',
        }
      throw new Error(`unexpected ${method}`)
    })
    await expect(
      runCharacterFactoryExecutor(config, completion, new AbortController().signal, { call }),
    ).resolves.toMatchObject({ state: 'completed', result: { status: 'SUCCEEDED' } })
    expect(call.mock.calls).toEqual([
      [
        'claimCharacterFactoryJob',
        { venueId: 'venue-a', requestId: 'request-a' },
        expect.anything(),
      ],
      [
        'heartbeatCharacterFactoryJob',
        { venueId: 'venue-a', requestId: 'request-a', leaseToken },
        expect.anything(),
      ],
      [
        'completeCharacterFactoryJob',
        expect.objectContaining({
          requestId: 'request-a',
          leaseToken,
          resultPayload: completion.resultPayload,
        }),
        expect.anything(),
      ],
    ])
  })

  it('does not execute or fail a request it did not claim', async () => {
    const call = vi.fn().mockResolvedValue({
      state: 'not-claimed',
      job: {
        id: 'job-a',
        requestId: 'request-a',
        venueId: 'venue-a',
        status: 'RUNNING',
        attemptNumber: 1,
        cancelRequested: false,
      },
    })
    await expect(
      runCharacterFactoryExecutor(config, completion, new AbortController().signal, { call }),
    ).resolves.toEqual({ state: 'not-claimed' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('marks a rejected heartbeat with a fixed safe failure before completion', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'claimCharacterFactoryJob')
        return { state: 'claimed', job: { requestId: 'request-a', venueId: 'venue-a', leaseToken } }
      if (method === 'heartbeatCharacterFactoryJob') throw new Error('cancelled')
      if (method === 'failCharacterFactoryJob') return { status: 'FAILED' }
      throw new Error(`unexpected ${method}`)
    })
    await expect(
      runCharacterFactoryExecutor(config, completion, new AbortController().signal, { call }),
    ).rejects.toMatchObject({ code: 'LEASE_REJECTED' })
    expect(call).toHaveBeenLastCalledWith(
      'failCharacterFactoryJob',
      expect.objectContaining({
        requestId: 'request-a',
        leaseToken,
        errorCode: 'CHARACTER_EXECUTOR_LEASE_REJECTED',
      }),
      expect.anything(),
    )
  })

  it('treats a malformed completion response as indeterminate without a failure write', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'claimCharacterFactoryJob')
        return { state: 'claimed', job: { requestId: 'request-a', venueId: 'venue-a', leaseToken } }
      if (method === 'heartbeatCharacterFactoryJob') return undefined
      if (method === 'completeCharacterFactoryJob') return { status: 'SUCCEEDED' }
      throw new Error(`unexpected ${method}`)
    })
    await expect(
      runCharacterFactoryExecutor(config, completion, new AbortController().signal, { call }),
    ).rejects.toMatchObject({ code: 'COMPLETION_INDETERMINATE' })
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('treats a lost completion response or timeout as indeterminate without a failure write', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'claimCharacterFactoryJob')
        return { state: 'claimed', job: { requestId: 'request-a', venueId: 'venue-a', leaseToken } }
      if (method === 'heartbeatCharacterFactoryJob') return undefined
      if (method === 'completeCharacterFactoryJob') throw new Error('BRIDGE_REQUEST_TIMEOUT')
      throw new Error(`unexpected ${method}`)
    })
    await expect(
      runCharacterFactoryExecutor(config, completion, new AbortController().signal, { call }),
    ).rejects.toMatchObject({ code: 'COMPLETION_INDETERMINATE' })
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('rejects malformed retained artifact input before it claims work', async () => {
    const call = vi.fn()
    await expect(
      runCharacterFactoryExecutor(
        config,
        { requestId: 'request-a', resultPayload: {}, assetStorageReference: { kind: 'bad' } },
        new AbortController().signal,
        { call },
      ),
    ).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  })
})

import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAiModelSpec } from './model-registry'
import {
  createOpenAiTextResponse,
  setOpenAiResponsesClientForTesting,
  type LocalSolEvaluationProfile,
} from './openai-text'

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rawResponse = () => ({
  id: 'resp_fictional_local_sol',
  model: 'gpt-6.1-sol',
  status: 'completed',
  service_tier: 'default',
  output_text: 'Fictional answer.',
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
})
function setup() {
  const input = {
    spec: structuredClone(getAiModelSpec('guest-chat-sol')),
    system: [
      {
        type: 'text' as const,
        text: 'Stable rules.',
        cache_control: { type: 'ephemeral' as const },
      },
      { type: 'text' as const, text: 'Current context.' },
    ],
    messages: [{ role: 'user' as const, content: 'Current question?' }],
    maxOutputTokens: 1024,
    timeoutMs: 20000,
  }
  const expectedSdk = {
    model: 'gpt-6.1-sol',
    input: [
      {
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: 'Stable rules.',
            prompt_cache_breakpoint: { mode: 'explicit' },
          },
        ],
      },
      { role: 'developer', content: [{ type: 'input_text', text: 'Current context.' }] },
      { role: 'user', content: 'Current question?' },
    ],
    prompt_cache_options: { mode: 'explicit' },
    max_output_tokens: 1024,
    reasoning: { effort: 'low' },
    store: false,
    service_tier: 'default',
  }
  const order: string[] = []
  const create = vi.fn(async () => {
    order.push('sdk')
    return rawResponse()
  })
  setOpenAiResponsesClientForTesting({ responses: { create } })
  const admit: LocalSolEvaluationProfile['admitReservedDispatch'] = vi.fn(async (binding) => {
    order.push('durable-admission')
    return {
      ...binding,
      reservationId: 'durable-fixture-reservation',
      attemptNumber: 1,
      dispatchRecorded: true,
    }
  })
  const observe: LocalSolEvaluationProfile['observeRawResponse'] = vi.fn(async (observation) => {
    order.push('raw-persisted')
    expect(observation.rawResponseSha256).toBe(sha(observation.rawResponse))
    expect(observation.sdkTransportMs).toBeGreaterThanOrEqual(0)
    return {
      callId: observation.callId,
      sdkRequestSha256: observation.sdkRequestSha256,
      rawResponseSha256: observation.rawResponseSha256,
      persisted: true as const,
    }
  })
  const localSolEvaluation: LocalSolEvaluationProfile = {
    profile: 'LOCAL_SOL_EVALUATION_V1',
    callId: `local-sol-${randomUUID()}`,
    expectedSdkRequestSha256: sha(expectedSdk),
    expectedAdapterInputsSha256: sha(input),
    admitReservedDispatch: admit,
    observeRawResponse: observe,
  }
  return { input, expectedSdk, create, order, admit, observe, localSolEvaluation }
}

describe('local Sol evaluation through the existing Responses owner', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'test'))
  afterEach(() => {
    vi.unstubAllEnvs()
    setOpenAiResponsesClientForTesting(null)
  })

  it('rebuilds the exact independently captured SDK bytes and fences one physical call', async () => {
    const f = setup()
    const result = await createOpenAiTextResponse({
      ...f.input,
      localSolEvaluation: f.localSolEvaluation,
    })
    expect(f.create).toHaveBeenCalledExactlyOnceWith(f.expectedSdk, { timeout: 20000 })
    expect(f.order).toEqual(['durable-admission', 'sdk', 'raw-persisted'])
    expect(f.admit).toHaveBeenCalledWith({
      callId: f.localSolEvaluation.callId,
      sdkRequestSha256: sha(f.expectedSdk),
      adapterInputsSha256: sha(f.input),
      reservedE8Usd: '51024000',
    })
    expect(result.text).toBe('Fictional answer.')
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
    ).rejects.toThrow('LOCAL_SOL_EVALUATION_CONTRACT_FAILED')
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it.each(['production', '', 'staging'])(
    'refuses local dispatch in environment %s',
    async (environment) => {
      const f = setup()
      vi.stubEnv('NODE_ENV', environment)
      await expect(
        createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
      ).rejects.toThrow()
      expect(f.create).not.toHaveBeenCalled()
      expect(f.admit).not.toHaveBeenCalled()
    },
  )

  it.each(['admission', 'observation'])(
    'requires the %s hook before provider admission',
    async (missing) => {
      const f = setup()
      const profile = {
        ...f.localSolEvaluation,
        [missing === 'admission' ? 'admitReservedDispatch' : 'observeRawResponse']: undefined,
      }
      await expect(
        createOpenAiTextResponse({
          ...f.input,
          localSolEvaluation: profile as unknown as LocalSolEvaluationProfile,
        }),
      ).rejects.toThrow()
      expect(f.create).not.toHaveBeenCalled()
    },
  )

  it('propagates rejected admission with zero physical calls', async () => {
    const f = setup()
    f.localSolEvaluation.admitReservedDispatch = async () => {
      throw new Error('ADMISSION_REFUSED')
    }
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
    ).rejects.toThrow('ADMISSION_REFUSED')
    expect(f.create).not.toHaveBeenCalled()
  })

  it('rejects source mutation during the awaited admission with zero physical calls', async () => {
    const f = setup(),
      original = f.localSolEvaluation.admitReservedDispatch
    f.localSolEvaluation.admitReservedDispatch = async (binding) => {
      f.input.messages[0]!.content = 'Changed question'
      return original(binding)
    }
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
    ).rejects.toThrow()
    expect(f.create).not.toHaveBeenCalled()
  })

  it.each(['sdk', 'inputs', 'reserve', 'attempt', 'dispatch'])(
    'refuses the altered %s binding before dispatch',
    async (changed) => {
      const f = setup()
      if (changed === 'sdk') f.localSolEvaluation.expectedSdkRequestSha256 = 'a'.repeat(64)
      if (changed === 'inputs') f.localSolEvaluation.expectedAdapterInputsSha256 = 'a'.repeat(64)
      if (['reserve', 'attempt', 'dispatch'].includes(changed)) {
        const original = f.localSolEvaluation.admitReservedDispatch
        f.localSolEvaluation.admitReservedDispatch = async (binding) => {
          const receipt = await original(binding)
          return {
            ...receipt,
            ...(changed === 'reserve' ? { reservedE8Usd: '0' } : {}),
            ...(changed === 'attempt' ? { attemptNumber: 2 } : {}),
            ...(changed === 'dispatch' ? { dispatchRecorded: false } : {}),
          } as unknown as typeof receipt
        }
      }
      await expect(
        createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
      ).rejects.toThrow()
      expect(f.create).not.toHaveBeenCalled()
    },
  )

  it('persists raw evidence before rejecting a response the ordinary parser cannot normalize', async () => {
    const f = setup()
    f.create.mockResolvedValueOnce({ ...rawResponse(), output_text: 123 } as never)
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
    ).rejects.toThrow()
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.order.at(-1)).toBe('raw-persisted')
  })

  it('does not retry or normalize when the raw evidence writer fails', async () => {
    const f = setup()
    f.localSolEvaluation.observeRawResponse = async () => {
      throw new Error('RAW_WRITER_FAILED')
    }
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
    ).rejects.toThrow('RAW_WRITER_FAILED')
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('observes then refuses incomplete accounting without another call', async () => {
    const f = setup(),
      raw = rawResponse()
    f.create.mockResolvedValueOnce({ ...raw, usage: { ...raw.usage, total_tokens: 1 } })
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
    ).rejects.toThrow()
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('propagates an ambiguous SDK failure once without raw settlement', async () => {
    const f = setup(),
      failure = new Error('SYNTHETIC_TRANSPORT_FAILURE')
    f.create.mockRejectedValueOnce(failure)
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: f.localSolEvaluation }),
    ).rejects.toBe(failure)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.observe).not.toHaveBeenCalled()
  })

  it('preserves ordinary production request bytes and does not pin their service tier', async () => {
    const f = setup()
    vi.stubEnv('NODE_ENV', 'production')
    await createOpenAiTextResponse(f.input)
    const ordinary: Partial<typeof f.expectedSdk> = { ...f.expectedSdk }
    delete ordinary.service_tier
    expect(f.create).toHaveBeenCalledExactlyOnceWith(ordinary, { timeout: 20000 })
    expect(f.admit).not.toHaveBeenCalled()
    expect(f.observe).not.toHaveBeenCalled()
  })
})

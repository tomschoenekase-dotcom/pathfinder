import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAiModelSpec } from './model-registry'
import {
  createOpenAiTextResponse,
  setOpenAiResponsesClientForTesting,
  type LocalCorpusEvaluationProfile,
  type LocalSolEvaluationProfile,
} from './openai-text'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function setup(modelKey: LocalCorpusEvaluationProfile['modelKey'] = 'guest-chat-luna') {
  const spec = getAiModelSpec(modelKey)
  const input = {
    spec,
    system: [
      {
        type: 'text' as const,
        text: 'Current whole guide body.',
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    messages: [{ role: 'user' as const, content: 'Current question?' }],
    maxOutputTokens: spec.maxOutputTokens,
    timeoutMs: spec.timeoutMs,
  }
  const expected = {
    model: spec.model,
    input: [
      {
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: input.system[0]!.text,
            prompt_cache_breakpoint: { mode: 'explicit' },
          },
        ],
      },
      ...input.messages,
    ],
    prompt_cache_options: { mode: 'explicit' },
    max_output_tokens: spec.maxOutputTokens,
    reasoning: { effort: modelKey === 'guest-chat-luna' ? 'none' : 'low' },
    store: false,
    service_tier: 'default',
  }
  const raw = {
    id: 'resp_fictional_corpus',
    model: spec.model,
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
  }
  const order: string[] = []
  const create = vi.fn(async () => {
    order.push('sdk')
    return raw
  })
  setOpenAiResponsesClientForTesting({ responses: { create } })
  const control: LocalCorpusEvaluationProfile = {
    profile: 'LOCAL_CORPUS_EVALUATION_V1',
    modelKey,
    callId: `corpus-${randomUUID()}`,
    expectedSdkRequestSha256: hash(expected),
    expectedAdapterInputsSha256: hash(input),
    admitReservedDispatch: vi.fn(async (binding) => {
      order.push('reserved-dispatch')
      return { ...binding, reservationId: 'fixture', attemptNumber: 1, dispatchRecorded: true }
    }),
    observeRawResponse: vi.fn(async (observation) => {
      order.push('raw-persisted')
      return {
        callId: observation.callId,
        sdkRequestSha256: observation.sdkRequestSha256,
        rawResponseSha256: observation.rawResponseSha256,
        persisted: true as const,
      }
    }),
  }
  return { input, expected, raw, order, create, control }
}

describe('separate local real-corpus evaluation profile', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'test'))
  afterEach(() => {
    vi.unstubAllEnvs()
    setOpenAiResponsesClientForTesting(null)
  })

  it.each(['guest-chat-luna', 'guest-chat-sol'] as const)(
    'binds exact %s registry/request/reservation and dispatches only once',
    async (modelKey) => {
      const f = setup(modelKey)
      const result = await createOpenAiTextResponse({
        ...f.input,
        localCorpusEvaluation: f.control,
      })
      expect(result.text).toBe('Fictional answer.')
      expect(f.create).toHaveBeenCalledExactlyOnceWith(f.expected, { timeout: f.input.timeoutMs })
      expect(f.order).toEqual(['reserved-dispatch', 'sdk', 'raw-persisted'])
      expect(f.control.admitReservedDispatch).toHaveBeenCalledWith({
        callId: f.control.callId,
        sdkRequestSha256: hash(f.expected),
        adapterInputsSha256: hash(f.input),
        reservedE8Usd: modelKey === 'guest-chat-luna' ? '2651200' : '52048000',
      })
      await expect(
        createOpenAiTextResponse({ ...f.input, localCorpusEvaluation: f.control }),
      ).rejects.toThrow()
      expect(f.create).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps original Sol pilot model substitution forbidden', async () => {
    const f = setup('guest-chat-luna')
    const oldProfile: LocalSolEvaluationProfile = {
      ...f.control,
      profile: 'LOCAL_SOL_EVALUATION_V1',
    }
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: oldProfile }),
    ).rejects.toThrow()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('refuses mixed pilot/corpus/planner profiles or a supplied abort signal', async () => {
    for (const extra of [
      { localSolEvaluation: { profile: 'LOCAL_SOL_EVALUATION_V1' } },
      { invocationProfile: 'LOCAL_LUNA_STANDARD_V1' },
      { signal: new AbortController().signal },
    ]) {
      const f = setup()
      await expect(
        createOpenAiTextResponse({
          ...f.input,
          localCorpusEvaluation: f.control,
          ...extra,
        } as Parameters<typeof createOpenAiTextResponse>[0]),
      ).rejects.toThrow()
      expect(f.create).not.toHaveBeenCalled()
    }
  })

  it.each(['production', 'staging', ''])('refuses %s before admission', async (environment) => {
    const f = setup()
    vi.stubEnv('NODE_ENV', environment)
    await expect(
      createOpenAiTextResponse({ ...f.input, localCorpusEvaluation: f.control }),
    ).rejects.toThrow()
    expect(f.control.admitReservedDispatch).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it.each(['modelKey', 'spec', 'pricing', 'timeout', 'output', 'requestHash', 'inputHash'])(
    'refuses altered %s before dispatch',
    async (change) => {
      const f = setup()
      if (change === 'modelKey')
        (f.control as { modelKey: string }).modelKey = 'guest-chat-luna-reasoning'
      if (change === 'spec') f.input.spec = { ...f.input.spec, model: 'gpt-6-astra' }
      if (change === 'pricing') f.input.spec = { ...f.input.spec, maxBillableInputTokens: 1 }
      if (change === 'timeout') f.input.timeoutMs = 20_000
      if (change === 'output') f.input.maxOutputTokens = 2048
      if (change === 'requestHash') f.control.expectedSdkRequestSha256 = 'a'.repeat(64)
      if (change === 'inputHash') f.control.expectedAdapterInputsSha256 = 'a'.repeat(64)
      await expect(
        createOpenAiTextResponse({ ...f.input, localCorpusEvaluation: f.control }),
      ).rejects.toThrow()
      expect(f.create).not.toHaveBeenCalled()
    },
  )

  it.each(['reserve', 'attempt', 'dispatch', 'sourceMutation', 'profileMutation'])(
    'refuses altered %s during awaited admission',
    async (change) => {
      const f = setup(),
        admit = f.control.admitReservedDispatch
      f.control.admitReservedDispatch = async (binding) => {
        const receipt = await admit(binding)
        if (change === 'sourceMutation') f.input.messages[0]!.content = 'Changed question'
        if (change === 'profileMutation') f.control.modelKey = 'guest-chat-sol'
        return {
          ...receipt,
          ...(change === 'reserve' ? { reservedE8Usd: '1' } : {}),
          ...(change === 'attempt' ? { attemptNumber: 2 } : {}),
          ...(change === 'dispatch' ? { dispatchRecorded: false } : {}),
        } as typeof receipt
      }
      await expect(
        createOpenAiTextResponse({ ...f.input, localCorpusEvaluation: f.control }),
      ).rejects.toThrow()
      expect(f.create).not.toHaveBeenCalled()
    },
  )

  it.each(['wrongModel', 'wrongTier', 'total', 'cache', 'reasoning', 'missingUsage'])(
    'persists then rejects %s once',
    async (change) => {
      const f = setup(),
        raw = structuredClone(f.raw)
      if (change === 'wrongModel') raw.model = 'gpt-6.1-sol'
      if (change === 'wrongTier') raw.service_tier = 'fast'
      if (change === 'total') raw.usage.total_tokens = 1
      if (change === 'cache') raw.usage.input_tokens_details.cached_tokens = 101
      if (change === 'reasoning') raw.usage.output_tokens_details.reasoning_tokens = 21
      if (change === 'missingUsage') delete (raw as { usage?: unknown }).usage
      f.create.mockResolvedValueOnce(raw)
      await expect(
        createOpenAiTextResponse({ ...f.input, localCorpusEvaluation: f.control }),
      ).rejects.toThrow()
      expect(f.control.observeRawResponse).toHaveBeenCalledTimes(1)
      expect(f.create).toHaveBeenCalledTimes(1)
    },
  )

  it('does not retry an ambiguous transport failure', async () => {
    const f = setup()
    f.create.mockRejectedValueOnce(new Error('FICTIONAL_TRANSPORT'))
    await expect(
      createOpenAiTextResponse({ ...f.input, localCorpusEvaluation: f.control }),
    ).rejects.toThrow('FICTIONAL_TRANSPORT')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.control.observeRawResponse).not.toHaveBeenCalled()
  })

  it('returns a completed empty answer for independent quality grading and allows the next call', async () => {
    const empty = setup()
    empty.create.mockResolvedValueOnce({ ...empty.raw, output_text: '' })
    const result = await createOpenAiTextResponse({
      ...empty.input,
      localCorpusEvaluation: empty.control,
    })
    expect(result.text).toBe('')
    expect(empty.create).toHaveBeenCalledTimes(1)
    const next = setup()
    await expect(
      createOpenAiTextResponse({ ...next.input, localCorpusEvaluation: next.control }),
    ).resolves.toMatchObject({ text: 'Fictional answer.' })
    expect(next.create).toHaveBeenCalledTimes(1)
  })

  it('keeps the original Sol pilot empty-answer stop', async () => {
    const f = setup('guest-chat-sol')
    f.create.mockResolvedValueOnce({ ...f.raw, output_text: '' })
    const oldProfile: LocalSolEvaluationProfile = {
      ...f.control,
      profile: 'LOCAL_SOL_EVALUATION_V1',
    }
    await expect(
      createOpenAiTextResponse({ ...f.input, localSolEvaluation: oldProfile }),
    ).rejects.toThrow()
    expect(f.create).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createOpenAiMediaJson,
  OPENAI_MEDIA_JSON_ATTEMPT_CEILING_UNITS,
  OPENAI_MEDIA_JSON_MODEL,
  OPENAI_MEDIA_JSON_MAX_OUTPUT_TOKENS,
  OPENAI_MEDIA_TRANSCRIPTION_ATTEMPT_CEILING_UNITS,
  OPENAI_MEDIA_TRANSCRIPTION_MODEL,
  resolveOpenAiMediaJsonModel,
  resolveOpenAiMediaTranscriptionModel,
  setOpenAiMediaClientForTesting,
  transcribeOpenAiMedia,
  type OpenAiMediaClient,
} from './openai-media'
import type { AiBudgetGate } from './budget'

const createChatCompletion = vi.fn()
const createTranscription = vi.fn()
const usageSink = vi.fn()
const reserve = vi.fn()
const markDispatched = vi.fn()
const settleExact = vi.fn()
const settleAmbiguous = vi.fn()
const releaseUndispatched = vi.fn()
const budgetGate: AiBudgetGate = {
  reserve,
  markDispatched,
  settleExact,
  settleAmbiguous,
  releaseUndispatched,
}
const client = {
  chat: { completions: { create: createChatCompletion } },
  audio: { transcriptions: { create: createTranscription } },
} as OpenAiMediaClient

describe('OpenAI media gateway', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    usageSink.mockResolvedValue(undefined)
    reserve.mockResolvedValue({ id: 'reservation_1', reservedUnits: 1n })
    markDispatched.mockResolvedValue(undefined)
    settleExact.mockResolvedValue(undefined)
    settleAmbiguous.mockResolvedValue(undefined)
    releaseUndispatched.mockResolvedValue(undefined)
    setOpenAiMediaClientForTesting(client)
  })

  afterEach(() => {
    setOpenAiMediaClientForTesting(null)
  })

  it('admits only the reviewed media model contracts', () => {
    expect(resolveOpenAiMediaJsonModel()).toBe(OPENAI_MEDIA_JSON_MODEL)
    expect(resolveOpenAiMediaJsonModel(OPENAI_MEDIA_JSON_MODEL)).toBe(OPENAI_MEDIA_JSON_MODEL)
    expect(() => resolveOpenAiMediaJsonModel('gpt-5-mini-2025-08-07')).toThrow('reviewed model')

    expect(resolveOpenAiMediaTranscriptionModel()).toBe(OPENAI_MEDIA_TRANSCRIPTION_MODEL)
    expect(resolveOpenAiMediaTranscriptionModel(OPENAI_MEDIA_TRANSCRIPTION_MODEL)).toBe(
      OPENAI_MEDIA_TRANSCRIPTION_MODEL,
    )
    expect(() => resolveOpenAiMediaTranscriptionModel('whisper-1')).toThrow('reviewed model')
    expect(OPENAI_MEDIA_JSON_ATTEMPT_CEILING_UNITS).toBe(65_040_000n)
    expect(OPENAI_MEDIA_TRANSCRIPTION_ATTEMPT_CEILING_UNITS).toBe(3_000_000n)
  })

  it('requests bounded JSON chat output and forwards cancellation', async () => {
    createChatCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: '{"summary":"entrance"}' } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    })
    const controller = new AbortController()

    await expect(
      createOpenAiMediaJson({
        model: OPENAI_MEDIA_JSON_MODEL,
        capability: 'MEDIA_ANALYSIS',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
        messages: [{ role: 'user', content: 'Inspect this.' }],
        signal: controller.signal,
      }),
    ).resolves.toEqual({ summary: 'entrance' })

    expect(createChatCompletion).toHaveBeenCalledWith(
      {
        model: OPENAI_MEDIA_JSON_MODEL,
        response_format: { type: 'json_object' },
        max_completion_tokens: OPENAI_MEDIA_JSON_MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: 'Inspect this.' }],
      },
      { signal: controller.signal },
    )
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'MEDIA_ANALYSIS',
        model: OPENAI_MEDIA_JSON_MODEL,
        success: true,
        usage: expect.objectContaining({
          inputTokens: 100,
          outputTokens: 30,
          cacheReadInputTokens: 20,
        }),
      }),
    )
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNumber: 1,
        model: OPENAI_MEDIA_JSON_MODEL,
        reservedUnits: OPENAI_MEDIA_JSON_ATTEMPT_CEILING_UNITS,
      }),
    )
    expect(markDispatched).toHaveBeenCalledOnce()
    expect(settleExact).toHaveBeenCalledWith(expect.anything(), 5_640n)
  })

  it('rejects malformed or empty media responses at the gateway', async () => {
    createChatCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 12, completion_tokens: 0 },
    })
    await expect(
      createOpenAiMediaJson({
        model: OPENAI_MEDIA_JSON_MODEL,
        capability: 'MEDIA_ANALYSIS',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
        messages: [{ role: 'user', content: 'Inspect this.' }],
      }),
    ).rejects.toThrow('OpenAI media JSON response was empty')
    expect(usageSink).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attempts: 1,
        errorCode: 'missing-text-block',
        success: false,
        usage: expect.objectContaining({ inputTokens: 12 }),
      }),
    )

    createChatCompletion.mockResolvedValueOnce({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 0 },
    })
    await expect(
      createOpenAiMediaJson({
        model: OPENAI_MEDIA_JSON_MODEL,
        capability: 'MEDIA_ANALYSIS',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
        messages: [{ role: 'user', content: 'Inspect this.' }],
      }),
    ).rejects.toThrow('OpenAI media JSON response was empty')
  })

  it('records billed usage when structured media output is rejected', async () => {
    createChatCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: '{not-json' } }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    })

    await expect(
      createOpenAiMediaJson({
        model: OPENAI_MEDIA_JSON_MODEL,
        capability: 'MEDIA_SYNTHESIS',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
        messages: [{ role: 'user', content: 'Synthesize this.' }],
      }),
    ).rejects.toThrow()

    expect(usageSink).toHaveBeenCalledOnce()
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        capability: 'MEDIA_SYNTHESIS',
        errorCode: 'invalid-structured-output',
        estimatedCostUsd: 0.0000211,
        success: false,
        usage: expect.objectContaining({
          inputTokens: 45,
          outputTokens: 10,
          cacheReadInputTokens: 5,
        }),
      }),
    )
  })

  it('applies the documented Luna long-context price multiplier', async () => {
    createChatCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 272_001, completion_tokens: 100 },
    })

    await createOpenAiMediaJson({
      model: OPENAI_MEDIA_JSON_MODEL,
      capability: 'MEDIA_SYNTHESIS',
      parseResponse: JSON.parse,
      usageSink,
      budgetGate,
      messages: [{ role: 'user', content: 'Synthesize this.' }],
    })

    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedCostUsd: 0.1089804, success: true }),
    )
  })

  it('transcribes a supplied media stream through the shared client', async () => {
    const file = { stream: true }
    createTranscription.mockResolvedValueOnce({
      text: 'Welcome to the north hall.',
      usage: {
        type: 'tokens',
        input_tokens: 80,
        output_tokens: 12,
        input_token_details: { audio_tokens: 80, text_tokens: 0 },
      },
    })

    await expect(
      transcribeOpenAiMedia({
        file,
        model: OPENAI_MEDIA_TRANSCRIPTION_MODEL,
        usageSink,
        budgetGate,
      }),
    ).resolves.toBe('Welcome to the north hall.')
    expect(createTranscription).toHaveBeenCalledWith(
      { file, model: OPENAI_MEDIA_TRANSCRIPTION_MODEL },
      undefined,
    )
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'MEDIA_TRANSCRIPTION',
        success: true,
        usage: expect.objectContaining({ audioInputTokens: 80, inputTokens: 80, outputTokens: 12 }),
      }),
    )
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        model: OPENAI_MEDIA_TRANSCRIPTION_MODEL,
        reservedUnits: OPENAI_MEDIA_TRANSCRIPTION_ATTEMPT_CEILING_UNITS,
      }),
    )
    expect(settleExact).toHaveBeenCalledWith(expect.anything(), 16_000n)
  })

  it('settles an unobserved provider failure at the conservative ceiling', async () => {
    createChatCompletion.mockRejectedValueOnce(new Error('connection reset'))

    await expect(
      createOpenAiMediaJson({
        model: OPENAI_MEDIA_JSON_MODEL,
        capability: 'MEDIA_ANALYSIS',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
        messages: [{ role: 'user', content: 'Inspect this.' }],
      }),
    ).rejects.toThrow('connection reset')

    expect(settleAmbiguous).toHaveBeenCalledOnce()
    expect(settleExact).not.toHaveBeenCalled()
  })

  it('releases the reservation when the dispatch fence fails', async () => {
    markDispatched.mockRejectedValueOnce(new Error('cost fence unavailable'))

    await expect(
      createOpenAiMediaJson({
        model: OPENAI_MEDIA_JSON_MODEL,
        capability: 'MEDIA_ANALYSIS',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
        messages: [{ role: 'user', content: 'Inspect this.' }],
      }),
    ).rejects.toThrow('cost fence unavailable')

    expect(releaseUndispatched).toHaveBeenCalledOnce()
    expect(createChatCompletion).not.toHaveBeenCalled()
    expect(settleAmbiguous).not.toHaveBeenCalled()
  })

  it('stops before provider I/O when the tenant budget denies the reservation', async () => {
    reserve.mockRejectedValueOnce(new Error('AI cost budget is exhausted'))

    await expect(
      createOpenAiMediaJson({
        model: OPENAI_MEDIA_JSON_MODEL,
        capability: 'MEDIA_ANALYSIS',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
        messages: [{ role: 'user', content: 'Inspect this.' }],
      }),
    ).rejects.toThrow('AI cost budget is exhausted')

    expect(createChatCompletion).not.toHaveBeenCalled()
    expect(markDispatched).not.toHaveBeenCalled()
    expect(releaseUndispatched).not.toHaveBeenCalled()
    expect(settleAmbiguous).not.toHaveBeenCalled()
  })
})

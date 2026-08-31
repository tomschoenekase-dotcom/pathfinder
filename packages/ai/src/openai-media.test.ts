import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createOpenAiMediaJson,
  setOpenAiMediaClientForTesting,
  transcribeOpenAiMedia,
  type OpenAiMediaClient,
} from './openai-media'

const createChatCompletion = vi.fn()
const createTranscription = vi.fn()
const client = {
  chat: { completions: { create: createChatCompletion } },
  audio: { transcriptions: { create: createTranscription } },
} as OpenAiMediaClient

describe('OpenAI media gateway', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setOpenAiMediaClientForTesting(client)
  })

  afterEach(() => {
    setOpenAiMediaClientForTesting(null)
  })

  it('requests bounded JSON chat output and forwards cancellation', async () => {
    createChatCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: '{"summary":"entrance"}' } }],
    })
    const controller = new AbortController()

    await expect(
      createOpenAiMediaJson({
        model: 'test-media-model',
        messages: [{ role: 'user', content: 'Inspect this.' }],
        signal: controller.signal,
      }),
    ).resolves.toBe('{"summary":"entrance"}')

    expect(createChatCompletion).toHaveBeenCalledWith(
      {
        model: 'test-media-model',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Inspect this.' }],
      },
      { signal: controller.signal },
    )
  })

  it('rejects malformed or empty media responses at the gateway', async () => {
    createChatCompletion.mockResolvedValueOnce({ choices: [{ message: { content: null } }] })
    await expect(
      createOpenAiMediaJson({
        model: 'test-media-model',
        messages: [{ role: 'user', content: 'Inspect this.' }],
      }),
    ).rejects.toThrow('OpenAI media JSON response was empty')

    createChatCompletion.mockResolvedValueOnce({ choices: [] })
    await expect(
      createOpenAiMediaJson({
        model: 'test-media-model',
        messages: [{ role: 'user', content: 'Inspect this.' }],
      }),
    ).rejects.toThrow('OpenAI media JSON response was empty')
  })

  it('transcribes a supplied media stream through the shared client', async () => {
    const file = { stream: true }
    createTranscription.mockResolvedValueOnce({ text: 'Welcome to the north hall.' })

    await expect(transcribeOpenAiMedia({ file, model: 'test-transcription-model' })).resolves.toBe(
      'Welcome to the north hall.',
    )
    expect(createTranscription).toHaveBeenCalledWith(
      { file, model: 'test-transcription-model' },
      undefined,
    )
  })
})

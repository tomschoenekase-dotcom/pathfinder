import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  analyzeGeminiVideo,
  GEMINI_VIDEO_ATTEMPT_CEILING_UNITS,
  GEMINI_VIDEO_MODEL,
  GEMINI_VIDEO_PRICING_VERSION,
  setGeminiVideoClientForTesting,
  type GeminiVideoClient,
} from './gemini-video'
import type { AiBudgetGate, AiBudgetReservationRef } from './budget'

const originalKey = process.env.GEMINI_API_KEY

afterEach(() => {
  setGeminiVideoClientForTesting(null)
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY
  else process.env.GEMINI_API_KEY = originalKey
  vi.restoreAllMocks()
})

function gate() {
  const reservation: AiBudgetReservationRef = {
    id: 'reservation-1',
    reservedUnits: GEMINI_VIDEO_ATTEMPT_CEILING_UNITS,
  }
  const budgetGate: AiBudgetGate = {
    reserve: vi.fn(async () => reservation),
    markDispatched: vi.fn(async () => undefined),
    settleExact: vi.fn(async () => undefined),
    settleAmbiguous: vi.fn(async () => undefined),
    releaseUndispatched: vi.fn(async () => undefined),
  }
  return { budgetGate, reservation }
}

function client(options?: {
  responseText?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
  }
  deleteFailure?: Error
  uploadFailure?: Error
  uploadWithoutName?: boolean
  uploadName?: string
}): GeminiVideoClient {
  return {
    files: {
      upload: vi.fn(async () => {
        if (options?.uploadFailure) throw options.uploadFailure
        return {
          ...(!options?.uploadWithoutName
            ? { name: options?.uploadName ?? 'files/client-tour' }
            : {}),
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/client-tour',
          mimeType: 'video/mp4',
          state: 'ACTIVE' as const,
        }
      }),
      get: vi.fn(),
      delete: vi.fn(async () => {
        if (options?.deleteFailure) throw options.deleteFailure
        return {}
      }),
    },
    models: {
      generateContent: vi.fn(
        async () =>
          ({
            text: options?.responseText ?? '{"summary":"A venue tour"}',
            usageMetadata: options?.usageMetadata ?? {
              promptTokenCount: 1_200,
              candidatesTokenCount: 100,
              cachedContentTokenCount: 200,
            },
          }) as never,
      ),
    },
  }
}

describe('Gemini video understanding', () => {
  it('reserves conservatively, analyzes the whole video, records exact usage, and deletes the file', async () => {
    const fakeClient = client()
    const { budgetGate, reservation } = gate()
    const usageSink = vi.fn(async () => undefined)
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'C:\\fixtures\\tour.mp4',
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return grounded JSON.',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
      }),
    ).resolves.toEqual({ summary: 'A venue tour' })

    expect(budgetGate.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        model: GEMINI_VIDEO_MODEL,
        pricingVersion: GEMINI_VIDEO_PRICING_VERSION,
        reservedUnits: GEMINI_VIDEO_ATTEMPT_CEILING_UNITS,
      }),
    )
    expect(budgetGate.markDispatched).toHaveBeenCalledWith(reservation)
    expect(fakeClient.files.upload).toHaveBeenCalledWith({
      file: 'C:\\fixtures\\tour.mp4',
      config: expect.objectContaining({
        name: expect.stringMatching(/^files\/torchiko-/u),
        abortSignal: expect.any(AbortSignal),
      }),
    })
    expect(budgetGate.settleExact).toHaveBeenCalledWith(reservation, 114_000n)
    expect(fakeClient.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          {
            fileData: {
              fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/client-tour',
              mimeType: 'video/mp4',
            },
          },
          { text: 'Return grounded JSON.' },
        ],
        config: expect.objectContaining({ responseMimeType: 'application/json' }),
      }),
    )
    expect(fakeClient.files.delete).toHaveBeenCalledWith({
      name: 'files/client-tour',
      config: { abortSignal: expect.any(AbortSignal) },
    })
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        capability: 'MEDIA_VIDEO_UNDERSTANDING',
        success: true,
        usage: expect.objectContaining({ inputTokens: 1_000, outputTokens: 100 }),
      }),
    )
  })

  it('deletes uploaded client video even when structured output is invalid', async () => {
    const fakeClient = client({ responseText: 'not-json' })
    const { budgetGate } = gate()
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink: vi.fn(async () => undefined),
        budgetGate,
      }),
    ).rejects.toBeInstanceOf(SyntaxError)

    expect(fakeClient.files.delete).toHaveBeenCalledOnce()
  })

  it('fails closed when deletion cannot be confirmed', async () => {
    const fakeClient = client({ deleteFailure: new Error('provider unavailable') })
    const { budgetGate } = gate()
    const usageSink = vi.fn(async () => undefined)
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
      }),
    ).rejects.toThrow('Gemini video file deletion could not be confirmed')

    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'provider-file-delete-unconfirmed',
        success: false,
      }),
    )
  })

  it('deletes the preselected provider identity when the upload response omits it', async () => {
    const fakeClient = client({ uploadWithoutName: true })
    const { budgetGate } = gate()
    const usageSink = vi.fn(async () => undefined)
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
      }),
    ).rejects.toThrow('Gemini video upload returned incomplete file identity')

    expect(fakeClient.files.delete).toHaveBeenCalledWith({
      name: expect.stringMatching(/^files\/torchiko-/u),
      config: { abortSignal: expect.any(AbortSignal) },
    })
    expect(usageSink).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
  })

  it('retains the preselected cleanup identity when the upload response name is blank', async () => {
    const fakeClient = client({ uploadName: '   ' })
    const { budgetGate } = gate()
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink: vi.fn(async () => undefined),
        budgetGate,
      }),
    ).resolves.toEqual({ summary: 'A venue tour' })

    expect(fakeClient.files.delete).toHaveBeenCalledWith({
      name: expect.stringMatching(/^files\/torchiko-/u),
      config: { abortSignal: expect.any(AbortSignal) },
    })
  })

  it('settles conservatively when a provider upload fails after dispatch begins', async () => {
    const fakeClient = client({ uploadFailure: new Error('upload interrupted') })
    const { budgetGate, reservation } = gate()
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink: vi.fn(async () => undefined),
        budgetGate,
      }),
    ).rejects.toThrow('upload interrupted')

    expect(budgetGate.markDispatched).toHaveBeenCalledWith(reservation)
    expect(budgetGate.settleAmbiguous).toHaveBeenCalledWith(reservation)
    expect(budgetGate.releaseUndispatched).not.toHaveBeenCalled()
    expect(fakeClient.files.delete).toHaveBeenCalledWith({
      name: expect.stringMatching(/^files\/torchiko-/u),
      config: { abortSignal: expect.any(AbortSignal) },
    })
  })

  it('settles conservatively when provider usage metadata is incomplete or impossible', async () => {
    const fakeClient = client({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: -1,
        cachedContentTokenCount: 200,
      },
    })
    const { budgetGate, reservation } = gate()
    const usageSink = vi.fn(async () => undefined)
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
      }),
    ).rejects.toThrow('invalid usage metadata')

    expect(budgetGate.settleExact).not.toHaveBeenCalled()
    expect(budgetGate.settleAmbiguous).toHaveBeenCalledWith(reservation)
    expect(fakeClient.files.delete).toHaveBeenCalledOnce()
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'provider-error', success: false }),
    )
  })

  it('releases an undispatched reservation when the provider key is absent', async () => {
    delete process.env.GEMINI_API_KEY
    const { budgetGate, reservation } = gate()

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink: vi.fn(async () => undefined),
        budgetGate,
      }),
    ).rejects.toThrow('GEMINI_API_KEY is not configured')

    expect(budgetGate.releaseUndispatched).toHaveBeenCalledWith(reservation)
    expect(budgetGate.markDispatched).not.toHaveBeenCalled()
  })
})

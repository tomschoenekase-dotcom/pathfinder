import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  analyzeGeminiVideo,
  GEMINI_VIDEO_FILE_MAX_BYTES,
  GEMINI_VIDEO_ATTEMPT_CEILING_UNITS,
  GEMINI_VIDEO_MODEL,
  GEMINI_VIDEO_PRICING_VERSION,
  GEMINI_VIDEO_PRICING_VERSION_2027,
  GEMINI_VIDEO_API_METHOD,
  GEMINI_VIDEO_PROCESSING_MODE,
  setGeminiVideoClientForTesting,
  type GeminiVideoClient,
} from './gemini-video'
import type { AiBudgetGate, AiBudgetReservationRef } from './budget'

const originalKey = process.env.GEMINI_API_KEY

afterEach(() => {
  vi.useRealTimers()
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
    thoughtsTokenCount?: number
    toolUsePromptTokenCount?: number
    totalTokenCount?: number
  }
  deleteFailure?: Error
  uploadFailure?: Error
  uploadWithoutName?: boolean
  uploadName?: string
  uploadState?: 'ACTIVE' | 'PROCESSING'
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
          state: options?.uploadState ?? ('ACTIVE' as const),
        }
      }),
      get: vi.fn(async ({ name }: { name: string }) => ({
        name,
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/client-tour',
        mimeType: 'video/mp4',
        state: 'ACTIVE' as const,
      })),
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
  it('reports the installed API route as static processing rather than agentic or exhaustive', () => {
    expect(GEMINI_VIDEO_API_METHOD).toBe('files-api+models.generateContent')
    expect(GEMINI_VIDEO_PROCESSING_MODE).toBe('static-default-1fps')
  })
  it('reserves conservatively, submits the uploaded video to static processing, records usage, and deletes the file', async () => {
    const fakeClient = client()
    const { budgetGate, reservation } = gate()
    const usageSink = vi.fn(async () => undefined)
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'C:\\fixtures\\tour.mp4',
        fileSizeBytes: 1_000_000,
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
        fileSizeBytes: 1_000_000,
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

    const result = analyzeGeminiVideo({
      filePath: 'tour.mp4',
      fileSizeBytes: 1_000_000,
      filename: 'tour.mp4',
      mimeType: 'video/mp4',
      model: GEMINI_VIDEO_MODEL,
      prompt: 'Return JSON.',
      parseResponse: JSON.parse,
      usageSink,
      budgetGate,
    })
    await expect(result).rejects.toMatchObject({
      message: 'Gemini video file deletion could not be confirmed',
      providerFileName: 'files/client-tour',
    })

    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'provider-file-delete-unconfirmed',
        success: false,
      }),
    )
  })

  it('uses and deletes the preselected provider identity when the upload response omits it', async () => {
    const fakeClient = client({ uploadWithoutName: true })
    const { budgetGate } = gate()
    const usageSink = vi.fn(async () => undefined)
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        fileSizeBytes: 1_000_000,
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
      }),
    ).resolves.toEqual({ summary: 'A venue tour' })

    expect(fakeClient.files.delete).toHaveBeenCalledWith({
      name: expect.stringMatching(/^files\/torchiko-/u),
      config: { abortSignal: expect.any(AbortSignal) },
    })
    expect(usageSink).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  })

  it('uses the preselected identity to poll and clean up when the upload response name is blank', async () => {
    vi.useFakeTimers()
    const fakeClient = client({ uploadName: '   ', uploadState: 'PROCESSING' })
    const { budgetGate } = gate()
    setGeminiVideoClientForTesting(fakeClient)

    const result = analyzeGeminiVideo({
      filePath: 'tour.mp4',
      fileSizeBytes: 1_000_000,
      filename: 'tour.mp4',
      mimeType: 'video/mp4',
      model: GEMINI_VIDEO_MODEL,
      prompt: 'Return JSON.',
      parseResponse: JSON.parse,
      usageSink: vi.fn(async () => undefined),
      budgetGate,
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toEqual({ summary: 'A venue tour' })

    expect(fakeClient.files.get).toHaveBeenCalledWith({
      name: expect.stringMatching(/^files\/torchiko-/u),
      config: { abortSignal: expect.any(AbortSignal) },
    })
    expect(fakeClient.files.delete).toHaveBeenCalledWith({
      name: expect.stringMatching(/^files\/torchiko-/u),
      config: { abortSignal: expect.any(AbortSignal) },
    })
    vi.useRealTimers()
  })

  it('refuses a known-oversize video before budget or provider dispatch', async () => {
    const fakeClient = client()
    const { budgetGate } = gate()
    const usageSink = vi.fn(async () => undefined)
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        fileSizeBytes: GEMINI_VIDEO_FILE_MAX_BYTES + 1,
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink,
        budgetGate,
      }),
    ).rejects.toThrow('Google Files API per-file limit')

    expect(budgetGate.reserve).not.toHaveBeenCalled()
    expect(fakeClient.files.upload).not.toHaveBeenCalled()
    expect(usageSink).toHaveBeenCalledWith(expect.objectContaining({ attempts: 0, success: false }))
  })

  it('settles conservatively when a provider upload fails after dispatch begins', async () => {
    const fakeClient = client({ uploadFailure: new Error('upload interrupted') })
    const { budgetGate, reservation } = gate()
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        fileSizeBytes: 1_000_000,
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
        fileSizeBytes: 1_000_000,
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
        fileSizeBytes: 1_000_000,
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

  it('rejects an already-aborted attempt before reservation or provider dispatch', async () => {
    const fakeClient = client()
    const { budgetGate } = gate()
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    setGeminiVideoClientForTesting(fakeClient)

    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        fileSizeBytes: 1_000_000,
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink: vi.fn(async () => undefined),
        budgetGate,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(budgetGate.reserve).not.toHaveBeenCalled()
    expect(budgetGate.markDispatched).not.toHaveBeenCalled()
    expect(fakeClient.files.upload).not.toHaveBeenCalled()
  })

  it('bills validated thinking tokens without retaining thought content', async () => {
    const fakeClient = client({
      usageMetadata: {
        promptTokenCount: 1_200,
        candidatesTokenCount: 100,
        cachedContentTokenCount: 200,
        thoughtsTokenCount: 50,
      },
    })
    const { budgetGate, reservation } = gate()
    setGeminiVideoClientForTesting(fakeClient)

    await analyzeGeminiVideo({
      filePath: 'tour.mp4',
      fileSizeBytes: 1_000_000,
      filename: 'tour.mp4',
      mimeType: 'video/mp4',
      model: GEMINI_VIDEO_MODEL,
      prompt: 'Return JSON.',
      parseResponse: JSON.parse,
      usageSink: vi.fn(async () => undefined),
      budgetGate,
      invokedAt: new Date('2026-12-31T23:59:59.999Z'),
    })

    expect(budgetGate.settleExact).toHaveBeenCalledWith(reservation, 132_750n)
  })

  it('rejects unexpected tool-use accounting and applies the 2027 effective price', async () => {
    const invalidClient = client({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        toolUsePromptTokenCount: 1,
      },
    })
    const invalidGate = gate()
    setGeminiVideoClientForTesting(invalidClient)
    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        fileSizeBytes: 1_000_000,
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink: vi.fn(async () => undefined),
        budgetGate: invalidGate.budgetGate,
      }),
    ).rejects.toThrow('invalid usage metadata')

    const futureClient = client()
    const futureGate = gate()
    const usageSink = vi.fn(async () => undefined)
    setGeminiVideoClientForTesting(futureClient)
    await analyzeGeminiVideo({
      filePath: 'tour.mp4',
      fileSizeBytes: 1_000_000,
      filename: 'tour.mp4',
      mimeType: 'video/mp4',
      model: GEMINI_VIDEO_MODEL,
      prompt: 'Return JSON.',
      parseResponse: JSON.parse,
      usageSink,
      budgetGate: futureGate.budgetGate,
      invokedAt: new Date('2027-01-01T00:00:00.000Z'),
    })

    expect(futureGate.budgetGate.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ pricingVersion: GEMINI_VIDEO_PRICING_VERSION_2027 }),
    )
    expect(futureGate.budgetGate.settleExact).toHaveBeenCalledWith(futureGate.reservation, 228_000n)
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ pricingVersion: GEMINI_VIDEO_PRICING_VERSION_2027 }),
    )
  })

  it('rejects an invalid pricing clock and inconsistent observable total tokens', async () => {
    const fakeClient = client()
    const invalidDateGate = gate()
    setGeminiVideoClientForTesting(fakeClient)
    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        fileSizeBytes: 1_000_000,
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink: vi.fn(async () => undefined),
        budgetGate: invalidDateGate.budgetGate,
        invokedAt: new Date(Number.NaN),
      }),
    ).rejects.toThrow('invocation time must be a valid date')
    expect(invalidDateGate.budgetGate.reserve).not.toHaveBeenCalled()

    const inconsistentClient = client({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        totalTokenCount: 125,
      },
    })
    const inconsistentGate = gate()
    setGeminiVideoClientForTesting(inconsistentClient)
    await expect(
      analyzeGeminiVideo({
        filePath: 'tour.mp4',
        fileSizeBytes: 1_000_000,
        filename: 'tour.mp4',
        mimeType: 'video/mp4',
        model: GEMINI_VIDEO_MODEL,
        prompt: 'Return JSON.',
        parseResponse: JSON.parse,
        usageSink: vi.fn(async () => undefined),
        budgetGate: inconsistentGate.budgetGate,
      }),
    ).rejects.toThrow('inconsistent total usage metadata')
    expect(inconsistentGate.budgetGate.settleAmbiguous).toHaveBeenCalledWith(
      inconsistentGate.reservation,
    )
  })
})

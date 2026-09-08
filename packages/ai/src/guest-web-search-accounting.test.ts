import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GuestWebSearchError, searchGuestWeb } from './guest-web-search'
import { searchGuestWebWithAccounting } from './guest-web-search-accounting'
import { withAiRequestBudgetCeiling } from './budget'

vi.mock('./guest-web-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./guest-web-search')>()),
  searchGuestWeb: vi.fn(),
}))

function fixture() {
  return {
    request: {
      query: 'What is a nebula?',
      allowedDomains: ['nasa.gov'],
      model: 'fixture-model',
      timeoutMs: 100,
      maxOutputTokens: 100,
      maxToolCalls: 1,
      maxResults: 3,
    },
    pricing: {
      model: 'fixture-model',
      version: 'fixture-pricing',
      maximumInputTokens: 1000,
      inputUnitsPerMillionTokens: 25_000_000n,
      cachedInputUnitsPerMillionTokens: 3_000_000n,
      outputUnitsPerMillionTokens: 200_000_000n,
      toolCallUnits: 1_000_000n,
    },
    invocationId: 'fixture-search',
    budgetGate: {
      reserve: vi.fn().mockResolvedValue({ id: 'reservation', reservedUnits: 1_045_000n }),
      markDispatched: vi.fn(),
      settleExact: vi.fn(),
      settleAmbiguous: vi.fn(),
      releaseUndispatched: vi.fn(),
    },
    admissionGuard: vi.fn(),
    beforeDispatch: vi.fn(),
    usageSink: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(searchGuestWeb).mockResolvedValue({
    provider: 'openai',
    model: 'fixture-model',
    responseId: 'response',
    text: 'General background.',
    references: [{ title: 'NASA', url: 'https://nasa.gov/a', cited: true }],
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      totalTokens: 110,
      webSearchToolCalls: 1,
    },
  })
})

describe('governed guest web search', () => {
  it('keeps search spend in the shared ceiling for subsequent generation', async () => {
    const input = fixture()
    const shared = withAiRequestBudgetCeiling(input.budgetGate, 1_045_000n)
    await searchGuestWebWithAccounting({ ...input, budgetGate: shared })
    await expect(
      shared.reserve({
        invocationId: 'generation',
        attemptNumber: 1,
        provider: 'openai',
        model: 'fixture-model',
        pricingVersion: 'fixture-pricing',
        reservedUnits: 50_000n,
      }),
    ).rejects.toThrow('cumulative cost ceiling')
    expect(input.budgetGate.reserve).toHaveBeenCalledOnce()
  })

  it('records observed billing even when the completed response has unusable citations', async () => {
    const input = fixture()
    const error = new GuestWebSearchError('Unsafe citation', 'invalid-provider-response')
    Object.assign(error, {
      observedUsage: {
        model: 'fixture-model',
        usage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          totalTokens: 110,
          webSearchToolCalls: 1,
        },
      },
    })
    vi.mocked(searchGuestWeb).mockRejectedValue(error)
    await expect(searchGuestWebWithAccounting(input)).rejects.toThrow('Unsafe citation')
    expect(input.budgetGate.settleExact).toHaveBeenCalledWith(expect.anything(), 1_004_060n)
    expect(input.budgetGate.settleAmbiguous).not.toHaveBeenCalled()
    expect(input.usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, usageObservationStatus: 'OBSERVED' }),
    )
  })

  it('rounds fractional E8 cached-token cost once for the aggregate', async () => {
    const input = fixture()
    input.pricing.cachedInputUnitsPerMillionTokens = 2_500_000n
    vi.mocked(searchGuestWeb).mockResolvedValue({
      provider: 'openai',
      model: 'fixture-model',
      responseId: 'response',
      text: 'Background.',
      references: [],
      usage: {
        inputTokens: 1,
        cachedInputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        webSearchToolCalls: 1,
      },
    })
    await searchGuestWebWithAccounting(input)
    expect(input.budgetGate.settleExact).toHaveBeenCalledWith(expect.anything(), 1_000_003n)
  })

  it('reserves before dispatch, rechecks admission, and settles tokens plus tool fee', async () => {
    const input = fixture()
    await searchGuestWebWithAccounting(input)
    expect(input.budgetGate.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ reservedUnits: 1_045_000n }),
    )
    expect(input.admissionGuard).toHaveBeenCalledTimes(2)
    expect(input.beforeDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(searchGuestWeb).mock.invocationCallOrder[0]!,
    )
    expect(input.budgetGate.settleExact).toHaveBeenCalledWith(expect.anything(), 1_004_060n)
    expect(input.usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, estimatedCostUsd: 0.0100406 }),
    )
  })
  it('never dispatches without a durable reservation', async () => {
    const input = fixture()
    input.budgetGate.reserve.mockResolvedValue(null)
    await expect(searchGuestWebWithAccounting(input)).rejects.toThrow('durable cost reservation')
    expect(searchGuestWeb).not.toHaveBeenCalled()
  })
  it('releases an undispatched reservation when permission is revoked', async () => {
    const input = fixture()
    input.beforeDispatch.mockRejectedValue(new Error('revoked'))
    await expect(searchGuestWebWithAccounting(input)).rejects.toThrow('revoked')
    expect(searchGuestWeb).not.toHaveBeenCalled()
    expect(input.budgetGate.releaseUndispatched).toHaveBeenCalledOnce()
    expect(input.budgetGate.settleAmbiguous).not.toHaveBeenCalled()
  })
  it('conservatively settles an unknown provider outcome without retry', async () => {
    const input = fixture()
    vi.mocked(searchGuestWeb).mockRejectedValue(new Error('timeout'))
    await expect(searchGuestWebWithAccounting(input)).rejects.toThrow('timeout')
    expect(searchGuestWeb).toHaveBeenCalledOnce()
    expect(input.budgetGate.settleAmbiguous).toHaveBeenCalledOnce()
    expect(input.budgetGate.releaseUndispatched).not.toHaveBeenCalled()
  })
  it('does not settle twice after usage persistence fails', async () => {
    const input = fixture()
    input.usageSink.mockRejectedValue(new Error('persistence'))
    await expect(searchGuestWebWithAccounting(input)).rejects.toThrow('persistence')
    expect(input.budgetGate.settleExact).toHaveBeenCalledOnce()
    expect(input.budgetGate.settleAmbiguous).not.toHaveBeenCalled()
  })
  it('rejects a pricing model mismatch before admission or dispatch', async () => {
    const input = fixture()
    input.pricing.model = 'different-model'
    await expect(searchGuestWebWithAccounting(input)).rejects.toThrow('pricing')
    expect(input.admissionGuard).not.toHaveBeenCalled()
    expect(searchGuestWeb).not.toHaveBeenCalled()
  })
})

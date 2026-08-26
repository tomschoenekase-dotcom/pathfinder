import { afterEach, describe, expect, it, vi } from 'vitest'

import { setAnthropicClientForTesting } from './anthropic'
import { setOpenAiResponsesClientForTesting } from './openai-text'
import {
  AiRequestBudgetCeilingExceededError,
  NOOP_AI_BUDGET_GATE,
  type AiBudgetGate,
} from './budget'
import { resolveAiWorkloadConfiguration } from './workload-configuration'
import { routeAiCapability } from './capability-routing'
import { generateTextForCapability } from './routed-generation'

describe('routed text generation', () => {
  afterEach(() => {
    setAnthropicClientForTesting(null)
    setOpenAiResponsesClientForTesting(null)
  })

  it('routes an explicitly selected OpenAI text model through the same controls', async () => {
    const create = vi.fn().mockResolvedValue({
      output_text: 'Bienvenido',
      output: [],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        input_tokens_details: { cached_tokens: 4 },
      },
    })
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: { primaryModelKey: 'guest-chat-openai', maxAttempts: 1 },
          unsafeChangesEnabled: true,
          reason: 'bounded OpenAI text canary',
        },
      ],
    })
    const usageSink = vi.fn().mockResolvedValue(undefined)
    const result = await generateTextForCapability({
      route: routeAiCapability({ capability: 'STANDARD', workloadId: 'guest-chat', configuration }),
      system: [{ type: 'text', text: 'Reply in the guest language.' }],
      messages: [{ role: 'user', content: 'Hola' }],
      maxAttempts: 1,
      usageSink,
      admissionGuard: vi.fn().mockResolvedValue(undefined),
      budgetGate: NOOP_AI_BUDGET_GATE,
    })

    expect(result).toMatchObject({
      text: 'Bienvenido',
      provider: 'openai',
      model: 'gpt-5-mini-2025-08-07',
      usage: { inputTokens: 8, outputTokens: 3, cacheReadInputTokens: 4 },
      route: { modelKey: 'guest-chat-openai', fallbackUsed: false },
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5-mini-2025-08-07',
        instructions: 'Reply in the guest language.',
        input: [{ role: 'user', content: 'Hola' }],
        store: false,
      }),
      expect.any(Object),
    )
    expect(usageSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'openai', routeModelKey: 'guest-chat-openai' }),
    )
  })

  it('uses an explicit fallback and annotates usage without repeating the dispatch fence', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Welcome' }],
        usage: { input_tokens: 2, output_tokens: 1 },
      })
    setAnthropicClientForTesting({ messages: { create } })
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: { fallback: { enabled: true, modelKeys: ['agent-run'] } },
          unsafeChangesEnabled: true,
          reason: 'test fallback',
        },
      ],
    })
    const usageSink = vi.fn().mockResolvedValue(undefined)
    const fence = vi.fn().mockResolvedValue(undefined)
    const reserve = vi.fn().mockResolvedValue(null)
    const budgetGate: AiBudgetGate = {
      reserve,
      markDispatched: vi.fn().mockResolvedValue(undefined),
      settleExact: vi.fn().mockResolvedValue(undefined),
      settleAmbiguous: vi.fn().mockResolvedValue(undefined),
      releaseUndispatched: vi.fn().mockResolvedValue(undefined),
    }
    const result = await generateTextForCapability({
      route: routeAiCapability({
        capability: 'STANDARD',
        workloadId: 'guest-chat',
        configuration,
      }),
      system: [{ type: 'text', text: 'Guide' }],
      messages: [{ role: 'user', content: 'Hello' }],
      maxAttempts: 1,
      usageSink,
      admissionGuard: vi.fn().mockResolvedValue(undefined),
      budgetGate,
      invocationId: '44444444-4444-4444-8444-444444444444',
      onBeforeFirstDispatch: fence,
    })

    expect(result.route).toMatchObject({ modelKey: 'agent-run', fallbackUsed: true })
    expect(fence).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledTimes(2)
    expect(reserve).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        invocationId: '44444444-4444-4444-8444-444444444444',
        attemptNumber: 2,
      }),
    )
    expect(usageSink).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capability: 'STANDARD',
        requestType: 'guest-chat',
        routeModelKey: 'agent-run',
        fallbackUsed: true,
      }),
    )
  })

  it('does not use a fallback to bypass an admission failure', async () => {
    const create = vi.fn()
    setAnthropicClientForTesting({ messages: { create } })
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: { fallback: { enabled: true, modelKeys: ['agent-run'] } },
          unsafeChangesEnabled: true,
          reason: 'test fallback',
        },
      ],
    })
    const admissionFailure = new Error('venue admission rejected')

    await expect(
      generateTextForCapability({
        route: routeAiCapability({
          capability: 'STANDARD',
          workloadId: 'guest-chat',
          configuration,
        }),
        system: [{ type: 'text', text: 'Guide' }],
        messages: [{ role: 'user', content: 'Hello' }],
        maxAttempts: 1,
        usageSink: vi.fn().mockResolvedValue(undefined),
        admissionGuard: vi.fn().mockRejectedValue(admissionFailure),
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toBe(admissionFailure)

    expect(create).not.toHaveBeenCalled()
  })

  it('rejects a governed request ceiling before any provider dispatch', async () => {
    const create = vi.fn()
    setAnthropicClientForTesting({ messages: { create } })
    const configuration = resolveAiWorkloadConfiguration({ workloadId: 'agent-run' })

    await expect(
      generateTextForCapability({
        route: routeAiCapability({
          capability: 'REASONING',
          workloadId: 'agent-run',
          configuration,
        }),
        system: [{ type: 'text', text: 'Operator' }],
        messages: [{ role: 'user', content: 'Analyze' }],
        maxOutputTokens: 1,
        maxAttempts: 1,
        requestBudgetCeilingE8Usd: '1',
        usageSink: vi.fn().mockResolvedValue(undefined),
        admissionGuard: vi.fn().mockResolvedValue(undefined),
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toBeInstanceOf(AiRequestBudgetCeilingExceededError)

    expect(create).not.toHaveBeenCalled()
  })
})

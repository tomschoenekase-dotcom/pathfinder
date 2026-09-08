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
        reasoning: { effort: 'minimal' },
        store: false,
      }),
      expect.any(Object),
    )
    expect(usageSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'openai', routeModelKey: 'guest-chat-openai' }),
    )
  })

  it('streams an OpenAI route and settles from the terminal response usage', async () => {
    const providerStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'response.output_text.delta', delta: 'Bien' }
        yield { type: 'response.output_text.delta', delta: 'venido' }
        yield {
          type: 'response.completed',
          response: {
            status: 'completed',
            output_text: 'Bienvenido',
            output: [],
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              input_tokens_details: { cached_tokens: 4 },
            },
          },
        }
      },
    }
    const create = vi.fn().mockResolvedValue(providerStream)
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: { primaryModelKey: 'guest-chat-openai', maxAttempts: 1 },
          unsafeChangesEnabled: true,
          reason: 'bounded OpenAI streaming canary',
        },
      ],
    })
    const onTextDelta = vi.fn()
    const result = await generateTextForCapability({
      route: routeAiCapability({ capability: 'STANDARD', workloadId: 'guest-chat', configuration }),
      system: [{ type: 'text', text: 'Reply in the guest language.' }],
      messages: [{ role: 'user', content: 'Hola' }],
      maxAttempts: 1,
      usageSink: vi.fn().mockResolvedValue(undefined),
      admissionGuard: vi.fn().mockResolvedValue(undefined),
      budgetGate: NOOP_AI_BUDGET_GATE,
      onTextDelta,
    })

    expect(onTextDelta.mock.calls.flat()).toEqual(['Bien', 'venido'])
    expect(result).toMatchObject({
      text: 'Bienvenido',
      usage: { inputTokens: 8, outputTokens: 3, cacheReadInputTokens: 4 },
      route: { modelKey: 'guest-chat-openai', fallbackUsed: false },
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true }),
      expect.any(Object),
    )
  })

  it.each(['incomplete', 'failed', 'cancelled', 'in_progress', 'queued'])(
    'rejects an OpenAI response with explicit noncompleted status %s after settling usage',
    async (status) => {
      const create = vi.fn().mockResolvedValue({
        status,
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        output_text: 'I do not have the closing',
        output: [],
        usage: {
          input_tokens: 12,
          output_tokens: 512,
          input_tokens_details: { cached_tokens: 4 },
        },
      })
      setOpenAiResponsesClientForTesting({ responses: { create } })
      const fallbackCreate = vi.fn()
      setAnthropicClientForTesting({ messages: { create: fallbackCreate } })
      const configuration = resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        overrides: [
          {
            activation: 'ENABLED',
            scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
            values: {
              primaryModelKey: 'guest-chat-openai',
              maxAttempts: 1,
              fallback: { enabled: true, modelKeys: ['agent-run'] },
            },
            unsafeChangesEnabled: true,
            reason: 'bounded OpenAI text canary',
          },
        ],
      })
      const usageSink = vi.fn().mockResolvedValue(undefined)
      const settleExact = vi.fn().mockResolvedValue(undefined)
      const budgetGate: AiBudgetGate = {
        reserve: vi.fn().mockResolvedValue({ id: 'known-incomplete', reservedUnits: 2_000_000n }),
        markDispatched: vi.fn().mockResolvedValue(undefined),
        settleExact,
        settleAmbiguous: vi.fn().mockResolvedValue(undefined),
        releaseUndispatched: vi.fn().mockResolvedValue(undefined),
      }

      await expect(
        generateTextForCapability({
          route: routeAiCapability({
            capability: 'STANDARD',
            workloadId: 'guest-chat',
            configuration,
          }),
          system: [{ type: 'text', text: 'Reply briefly.' }],
          messages: [{ role: 'user', content: 'When do you close?' }],
          maxAttempts: 1,
          usageSink,
          admissionGuard: vi.fn().mockResolvedValue(undefined),
          budgetGate,
        }),
      ).rejects.toMatchObject({ code: 'provider-incomplete-response', attempts: 1 })
      expect(fallbackCreate).not.toHaveBeenCalled()
      expect(create).toHaveBeenCalledTimes(1)
      expect(settleExact).toHaveBeenCalledWith(
        { id: 'known-incomplete', reservedUnits: 2_000_000n },
        expect.any(BigInt),
      )
      expect(usageSink).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'provider-incomplete-response',
          routeModelKey: 'guest-chat-openai',
          usage: expect.objectContaining({
            inputTokens: 8,
            outputTokens: 512,
            cacheReadInputTokens: 4,
          }),
        }),
      )
    },
  )

  it.each([undefined, 'incomplete'])(
    'settles terminal streamed usage before rejecting an incomplete event with status %s',
    async (status) => {
      const create = vi.fn().mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'response.output_text.delta', delta: 'Partial' }
          yield {
            type: 'response.incomplete',
            response: {
              ...(status === undefined ? {} : { status }),
              output_text: 'Partial',
              usage: {
                input_tokens: 9,
                output_tokens: 7,
                input_tokens_details: { cached_tokens: 2 },
              },
            },
          }
        },
      })
      setOpenAiResponsesClientForTesting({ responses: { create } })
      const configuration = resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        overrides: [
          {
            activation: 'ENABLED',
            scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
            values: {
              primaryModelKey: 'guest-chat-openai',
              maxAttempts: 1,
              fallback: { enabled: true, modelKeys: ['agent-run'] },
            },
            unsafeChangesEnabled: true,
            reason: 'streamed cutoff proof',
          },
        ],
      })
      const usageSink = vi.fn().mockResolvedValue(undefined)
      const onTextDelta = vi.fn()
      const fallbackCreate = vi.fn()
      setAnthropicClientForTesting({ messages: { create: fallbackCreate } })
      const settleExact = vi.fn().mockResolvedValue(undefined)
      const budgetGate: AiBudgetGate = {
        reserve: vi.fn().mockResolvedValue({ id: 'stream-incomplete', reservedUnits: 100_000n }),
        markDispatched: vi.fn().mockResolvedValue(undefined),
        settleExact,
        settleAmbiguous: vi.fn().mockResolvedValue(undefined),
        releaseUndispatched: vi.fn().mockResolvedValue(undefined),
      }
      await expect(
        generateTextForCapability({
          route: routeAiCapability({
            capability: 'STANDARD',
            workloadId: 'guest-chat',
            configuration,
          }),
          system: [{ type: 'text', text: 'Brief.' }],
          messages: [{ role: 'user', content: 'Hello' }],
          maxAttempts: 1,
          usageSink,
          admissionGuard: vi.fn().mockResolvedValue(undefined),
          budgetGate,
          onTextDelta,
        }),
      ).rejects.toMatchObject({
        code: 'provider-incomplete-response',
        attempts: 1,
        textEmitted: true,
      })
      expect(onTextDelta).toHaveBeenCalledWith('Partial')
      expect(create).toHaveBeenCalledTimes(1)
      expect(fallbackCreate).not.toHaveBeenCalled()
      expect(settleExact).toHaveBeenCalledWith(
        { id: 'stream-incomplete', reservedUnits: 100_000n },
        expect.any(BigInt),
      )
      expect(settleExact.mock.calls[0]?.[1]).toBeGreaterThan(0n)
      expect(budgetGate.settleAmbiguous).not.toHaveBeenCalled()
      expect(usageSink).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          usage: expect.objectContaining({
            inputTokens: 7,
            outputTokens: 7,
            cacheReadInputTokens: 2,
          }),
          errorCode: 'provider-incomplete-response',
        }),
      )
    },
  )

  it.each([null, undefined])(
    'keeps incomplete OpenAI usage %s ambiguous rather than settling zero',
    async (usage) => {
      const create = vi.fn().mockResolvedValue({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: 'Partial',
        ...(usage === undefined ? {} : { usage }),
      })
      setOpenAiResponsesClientForTesting({ responses: { create } })
      const fallbackCreate = vi.fn()
      setAnthropicClientForTesting({ messages: { create: fallbackCreate } })
      const configuration = resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        overrides: [
          {
            activation: 'ENABLED',
            scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
            values: {
              primaryModelKey: 'guest-chat-openai',
              maxAttempts: 1,
              fallback: { enabled: true, modelKeys: ['agent-run'] },
            },
            unsafeChangesEnabled: true,
            reason: 'unknown usage proof',
          },
        ],
      })
      const usageSink = vi.fn().mockResolvedValue(undefined)
      const settleAmbiguous = vi.fn().mockResolvedValue(undefined)
      const settleExact = vi.fn().mockResolvedValue(undefined)
      const budgetGate: AiBudgetGate = {
        reserve: vi.fn().mockResolvedValue({ id: 'openai-unknown', reservedUnits: 100n }),
        markDispatched: vi.fn().mockResolvedValue(undefined),
        settleExact,
        settleAmbiguous,
        releaseUndispatched: vi.fn().mockResolvedValue(undefined),
      }
      await expect(
        generateTextForCapability({
          route: routeAiCapability({
            capability: 'STANDARD',
            workloadId: 'guest-chat',
            configuration,
          }),
          system: [{ type: 'text', text: 'Brief.' }],
          messages: [{ role: 'user', content: 'Hello' }],
          maxAttempts: 1,
          usageSink,
          admissionGuard: vi.fn().mockResolvedValue(undefined),
          budgetGate,
        }),
      ).rejects.toBeTruthy()
      expect(create).toHaveBeenCalledTimes(1)
      expect(settleAmbiguous).toHaveBeenCalledWith({ id: 'openai-unknown', reservedUnits: 100n })
      expect(settleExact).not.toHaveBeenCalled()
      expect(fallbackCreate).not.toHaveBeenCalled()
    },
  )

  it('rejects a failed terminal stream event when provider status is absent', async () => {
    const usageSink = vi.fn().mockResolvedValue(undefined)
    const settleExact = vi.fn().mockResolvedValue(undefined)
    const settleAmbiguous = vi.fn().mockResolvedValue(undefined)
    const budgetGate: AiBudgetGate = {
      reserve: vi.fn().mockResolvedValue({ id: 'failed-stream', reservedUnits: 100_000n }),
      markDispatched: vi.fn().mockResolvedValue(undefined),
      settleExact,
      settleAmbiguous,
      releaseUndispatched: vi.fn().mockResolvedValue(undefined),
    }
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'response.failed',
          response: {
            output_text: 'Must not escape',
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        }
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
          reason: 'failed terminal proof',
        },
      ],
    })
    await expect(
      generateTextForCapability({
        route: routeAiCapability({
          capability: 'STANDARD',
          workloadId: 'guest-chat',
          configuration,
        }),
        system: [{ type: 'text', text: 'Brief.' }],
        messages: [{ role: 'user', content: 'Hello' }],
        maxAttempts: 1,
        usageSink,
        admissionGuard: vi.fn().mockResolvedValue(undefined),
        budgetGate,
        onTextDelta: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'provider-incomplete-response' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(settleExact.mock.calls[0]?.[1]).toBeGreaterThan(0n)
    expect(settleAmbiguous).not.toHaveBeenCalled()
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        usage: expect.objectContaining({ inputTokens: 4, outputTokens: 2 }),
      }),
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

  it('does not switch route candidates after a streamed fragment reaches the guest', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Fallback must not run' }],
      usage: { input_tokens: 2, output_tokens: 4 },
    })
    const stream = vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial' } }
        throw Object.assign(new Error('provider unavailable'), { status: 503 })
      },
      finalMessage: vi.fn(),
    })
    setAnthropicClientForTesting({ messages: { create, stream } })
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: { fallback: { enabled: true, modelKeys: ['agent-run'] } },
          unsafeChangesEnabled: true,
          reason: 'test streamed fallback fence',
        },
      ],
    })
    const onTextDelta = vi.fn()

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
        admissionGuard: vi.fn().mockResolvedValue(undefined),
        budgetGate: NOOP_AI_BUDGET_GATE,
        onTextDelta,
      }),
    ).rejects.toMatchObject({ textEmitted: true, attempts: 1 })

    expect(onTextDelta).toHaveBeenCalledWith('Partial')
    expect(stream).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
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

  it('fails closed when a stale route model identity no longer matches dispatch', async () => {
    const create = vi.fn()
    setAnthropicClientForTesting({ messages: { create } })
    const usageSink = vi.fn().mockResolvedValue(undefined)
    const admissionGuard = vi.fn().mockResolvedValue(undefined)
    const reserve = vi.fn().mockResolvedValue(null)
    const budgetGate: AiBudgetGate = {
      reserve,
      markDispatched: vi.fn().mockResolvedValue(undefined),
      settleExact: vi.fn().mockResolvedValue(undefined),
      settleAmbiguous: vi.fn().mockResolvedValue(undefined),
      releaseUndispatched: vi.fn().mockResolvedValue(undefined),
    }
    const configuration = resolveAiWorkloadConfiguration({ workloadId: 'guest-chat' })
    const route = routeAiCapability({
      capability: 'STANDARD',
      workloadId: 'guest-chat',
      configuration,
    })
    route.candidates[0] = { ...route.candidates[0]!, model: 'stale-protected-model' }

    await expect(
      generateTextForCapability({
        route,
        system: [{ type: 'text', text: 'Guide' }],
        messages: [{ role: 'user', content: 'Hello' }],
        maxAttempts: 1,
        usageSink,
        admissionGuard,
        budgetGate,
      }),
    ).rejects.toThrow('Text model identity mismatch for guest-chat')

    expect(create).not.toHaveBeenCalled()
    expect(admissionGuard).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(usageSink).not.toHaveBeenCalled()
  })

  it('fails closed on a stale fallback after the primary provider fails', async () => {
    const primaryCreate = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }))
    const fallbackCreate = vi.fn()
    setOpenAiResponsesClientForTesting({ responses: { create: primaryCreate } })
    setAnthropicClientForTesting({ messages: { create: fallbackCreate } })
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: {
            primaryModelKey: 'guest-chat-openai',
            maxAttempts: 1,
            fallback: { enabled: true, modelKeys: ['agent-run'] },
          },
          unsafeChangesEnabled: true,
          reason: 'stale fallback proof',
        },
      ],
    })
    const route = routeAiCapability({
      capability: 'STANDARD',
      workloadId: 'guest-chat',
      configuration,
    })
    route.candidates[1] = { ...route.candidates[1]!, model: 'stale-protected-model' }
    const usageSink = vi.fn().mockResolvedValue(undefined)
    const admissionGuard = vi.fn().mockResolvedValue(undefined)
    const reserve = vi.fn().mockResolvedValue(null)
    const budgetGate: AiBudgetGate = {
      reserve,
      markDispatched: vi.fn().mockResolvedValue(undefined),
      settleExact: vi.fn().mockResolvedValue(undefined),
      settleAmbiguous: vi.fn().mockResolvedValue(undefined),
      releaseUndispatched: vi.fn().mockResolvedValue(undefined),
    }

    await expect(
      generateTextForCapability({
        route,
        system: [{ type: 'text', text: 'Guide' }],
        messages: [{ role: 'user', content: 'Hello' }],
        maxAttempts: 1,
        usageSink,
        admissionGuard,
        budgetGate,
      }),
    ).rejects.toThrow('Text model identity mismatch for agent-run')

    expect(primaryCreate).toHaveBeenCalledTimes(1)
    expect(fallbackCreate).not.toHaveBeenCalled()
    expect(admissionGuard).toHaveBeenCalledTimes(2)
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledTimes(1)
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

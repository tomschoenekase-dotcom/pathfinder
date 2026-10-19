import { describe, expect, it } from 'vitest'

import { AI_EMBEDDING_MODEL_REGISTRY } from './embedding-model-registry'
import { AI_MODEL_KEYS, AI_MODEL_REGISTRY } from './model-registry'
import {
  AI_CENTRAL_MODEL_REGISTRY,
  AI_PROVIDER_REGISTRY,
  resolveAiWorkloadConfiguration,
} from './workload-configuration'

const enabled = (
  scope: Record<string, string>,
  values: Record<string, unknown>,
  unsafe = false,
) => ({
  activation: 'ENABLED',
  scope,
  values,
  unsafeChangesEnabled: unsafe,
  reason: 'test policy',
})

describe('central AI workload configuration', () => {
  it('supports an explicit platform default model while preserving workload identity', () => {
    const result = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      defaultPrimaryModelKey: 'guest-chat-luna',
    })
    expect(result).toMatchObject({
      workloadId: 'guest-chat',
      primaryModelKey: 'guest-chat-luna',
      model: { provider: 'openai', model: 'gpt-6-luna' },
    })
  })

  it('projects every existing registry entry without changing pricing metadata', () => {
    expect(Object.keys(AI_CENTRAL_MODEL_REGISTRY).sort()).toEqual(
      [...Object.keys(AI_MODEL_REGISTRY), ...Object.keys(AI_EMBEDDING_MODEL_REGISTRY)].sort(),
    )
    expect(AI_CENTRAL_MODEL_REGISTRY['guest-chat'].pricingVersion).toBe(
      AI_MODEL_REGISTRY['guest-chat'].pricingVersion,
    )
    expect(
      AI_CENTRAL_MODEL_REGISTRY['guest-query-embedding'].pricingUsdPerMillionTokens.input,
    ).toBe(AI_EMBEDDING_MODEL_REGISTRY['guest-query-embedding'].inputUsdPerMillionTokens)
    expect(AI_PROVIDER_REGISTRY).toEqual({
      anthropic: { id: 'anthropic', capabilities: ['TEXT'] },
      deepseek: { id: 'deepseek', capabilities: ['TEXT'] },
      openai: { id: 'openai', capabilities: ['TEXT', 'EMBEDDING'] },
    })
  })

  it.each(['guest-chat', 'guest-chat-luna', 'guest-chat-sol'] as const)(
    'uses reasoning-model defaults when selected over the %s default without explicit limits',
    (defaultPrimaryModelKey) => {
      const result = resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        defaultPrimaryModelKey,
        overrides: [
          enabled(
            { level: 'WORKLOAD', workloadId: 'guest-chat' },
            { primaryModelKey: 'guest-chat-luna-reasoning' },
            true,
          ),
        ],
      })
      expect(result).toMatchObject({
        primaryModelKey: 'guest-chat-luna-reasoning',
        maxOutputTokens: 2_048,
        timeoutMs: 20_000,
        maxAttempts: AI_MODEL_REGISTRY['guest-chat-luna-reasoning'].maxAttempts,
        sources: {
          primaryModelKey: 'WORKLOAD',
          timeoutMs: 'WORKLOAD',
          maxAttempts: 'WORKLOAD',
          maxOutputTokens: 'WORKLOAD',
        },
      })
    },
  )

  it.each(['guest-chat', 'guest-chat-luna', 'guest-chat-sol', 'answer-analysis'] as const)(
    'uses the selected %s limits rather than the largest limits from other models',
    (primaryModelKey) => {
      const result = resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        defaultPrimaryModelKey: 'guest-chat-luna-reasoning',
        overrides: [
          enabled({ level: 'WORKLOAD', workloadId: 'guest-chat' }, { primaryModelKey }, true),
        ],
      })
      const spec = AI_MODEL_REGISTRY[primaryModelKey]
      expect(result.timeoutMs).toBe(spec.timeoutMs)
      expect(result.maxAttempts).toBe(spec.maxAttempts)
      expect(result.maxOutputTokens).toBe(spec.maxOutputTokens)
    },
  )

  it('preserves explicit inherited limits and the request budget when a later layer selects a model', () => {
    const result = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        enabled(
          { level: 'PLATFORM' },
          {
            timeoutMs: 8_000,
            maxAttempts: 1,
            maxOutputTokens: 400,
            requestBudgetCeilingE8Usd: '1000',
          },
        ),
        enabled(
          { level: 'WORKLOAD', workloadId: 'guest-chat' },
          { primaryModelKey: 'guest-chat-luna-reasoning' },
          true,
        ),
      ],
    })
    expect(result).toMatchObject({
      primaryModelKey: 'guest-chat-luna-reasoning',
      timeoutMs: 8_000,
      maxAttempts: 1,
      maxOutputTokens: 400,
      requestBudgetCeilingE8Usd: '1000',
      sources: {
        timeoutMs: 'PLATFORM',
        maxAttempts: 'PLATFORM',
        maxOutputTokens: 'PLATFORM',
        requestBudgetCeilingE8Usd: 'PLATFORM',
      },
    })
  })

  it('preserves same-layer explicit limits and applies more specific limits field by field', () => {
    const result = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      clientId: 'client-1',
      overrides: [
        enabled(
          { level: 'WORKLOAD', workloadId: 'guest-chat' },
          { primaryModelKey: 'guest-chat-luna-reasoning', timeoutMs: 12_000, maxOutputTokens: 768 },
          true,
        ),
        enabled(
          { level: 'CLIENT', workloadId: 'guest-chat', clientId: 'client-1' },
          { timeoutMs: 9_000, maxAttempts: 1 },
        ),
      ],
    })
    expect(result).toMatchObject({
      timeoutMs: 9_000,
      maxOutputTokens: 768,
      maxAttempts: 1,
      sources: { timeoutMs: 'CLIENT', maxOutputTokens: 'WORKLOAD', maxAttempts: 'CLIENT' },
    })
  })

  it('keeps explicit null output limits while implicit limits follow successive model selections', () => {
    const result = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      clientId: 'client-1',
      overrides: [
        enabled({ level: 'PLATFORM' }, { maxOutputTokens: null }),
        enabled(
          { level: 'WORKLOAD', workloadId: 'guest-chat' },
          { primaryModelKey: 'guest-chat-luna-reasoning' },
          true,
        ),
        enabled(
          { level: 'CLIENT', workloadId: 'guest-chat', clientId: 'client-1' },
          { primaryModelKey: 'guest-chat-luna' },
          true,
        ),
      ],
    })
    expect(result).toMatchObject({
      primaryModelKey: 'guest-chat-luna',
      timeoutMs: 15_000,
      maxOutputTokens: null,
      sources: { timeoutMs: 'CLIENT', maxOutputTokens: 'PLATFORM' },
    })
  })

  it.each(['guest-chat', 'guest-chat-luna', 'guest-chat-sol'] as const)(
    'leaves the existing %s route unchanged without overrides',
    (defaultPrimaryModelKey) => {
      const result = resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        defaultPrimaryModelKey,
      })
      const spec = AI_MODEL_REGISTRY[defaultPrimaryModelKey]
      expect(result).toMatchObject({
        primaryModelKey: defaultPrimaryModelKey,
        timeoutMs: spec.timeoutMs,
        maxAttempts: spec.maxAttempts,
        maxOutputTokens: spec.maxOutputTokens,
        sources: {
          primaryModelKey: 'PLATFORM',
          timeoutMs: 'PLATFORM',
          maxAttempts: 'PLATFORM',
          maxOutputTokens: 'PLATFORM',
        },
      })
    },
  )

  it('resolves platform, workload, client, and venue layers field by field', () => {
    const result = resolveAiWorkloadConfiguration({
      workloadId: AI_MODEL_KEYS.GUEST_CHAT,
      clientId: 'client-1',
      venueId: 'venue-1',
      overrides: [
        enabled(
          { level: 'VENUE', workloadId: 'guest-chat', clientId: 'client-1', venueId: 'venue-1' },
          { timeoutMs: 8_000 },
        ),
        enabled({ level: 'PLATFORM' }, { timeoutMs: 20_000 }),
        enabled(
          { level: 'CLIENT', workloadId: 'guest-chat', clientId: 'client-1' },
          { maxAttempts: 1 },
        ),
        enabled({ level: 'WORKLOAD', workloadId: 'guest-chat' }, { maxOutputTokens: 400 }),
      ],
    })

    expect(result).toMatchObject({
      timeoutMs: 8_000,
      maxAttempts: 1,
      maxOutputTokens: 400,
      fallback: { enabled: false, modelKeys: [] },
      sources: {
        timeoutMs: 'VENUE',
        maxAttempts: 'CLIENT',
        maxOutputTokens: 'WORKLOAD',
        fallback: 'PLATFORM',
      },
    })
  })

  it('ignores disabled records and rejects mismatched tenant scope', () => {
    expect(
      resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        overrides: [
          { scope: { level: 'PLATFORM' }, values: { timeoutMs: 100 }, reason: 'staged only' },
        ],
      }).timeoutMs,
    ).toBe(AI_MODEL_REGISTRY['guest-chat'].timeoutMs)

    expect(() =>
      resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        clientId: 'client-1',
        overrides: [
          enabled(
            { level: 'CLIENT', workloadId: 'guest-chat', clientId: 'client-2' },
            { timeoutMs: 500 },
          ),
        ],
      }),
    ).toThrow('another client')
  })

  it('keeps fallback, model changes, retry expansion, and budget removal default-off', () => {
    for (const values of [
      { fallback: { enabled: true, modelKeys: ['answer-analysis'] } },
      { primaryModelKey: 'answer-analysis' },
      { maxAttempts: 5 },
    ]) {
      expect(() =>
        resolveAiWorkloadConfiguration({
          workloadId: 'guest-chat',
          overrides: [enabled({ level: 'WORKLOAD', workloadId: 'guest-chat' }, values)],
        }),
      ).toThrow('default-off unsafe change')
    }

    expect(() =>
      resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        overrides: [
          enabled({ level: 'PLATFORM' }, { requestBudgetCeilingE8Usd: '1000' }),
          enabled(
            { level: 'WORKLOAD', workloadId: 'guest-chat' },
            { requestBudgetCeilingE8Usd: null },
          ),
        ],
      }),
    ).toThrow('default-off unsafe change')
  })

  it('permits explicitly acknowledged same-kind model changes but never cross-kind changes', () => {
    const result = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        enabled(
          { level: 'WORKLOAD', workloadId: 'guest-chat' },
          {
            primaryModelKey: 'answer-analysis',
            fallback: { enabled: true, modelKeys: ['weekly-digest'] },
          },
          true,
        ),
      ],
    })
    expect(result.primaryModelKey).toBe('answer-analysis')
    expect(result.model.model).toBe(AI_MODEL_REGISTRY['answer-analysis'].model)

    expect(() =>
      resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        overrides: [
          enabled(
            { level: 'WORKLOAD', workloadId: 'guest-chat' },
            { primaryModelKey: 'guest-query-embedding' },
            true,
          ),
        ],
      }),
    ).toThrow('model kind')
  })

  it('rejects unknown fields that could smuggle credentials or provider endpoints', () => {
    expect(() =>
      resolveAiWorkloadConfiguration({
        workloadId: 'guest-chat',
        overrides: [
          {
            ...enabled({ level: 'PLATFORM' }, { timeoutMs: 500 }),
            apiKey: 'not-allowed',
          },
        ],
      }),
    ).toThrow()
  })
})

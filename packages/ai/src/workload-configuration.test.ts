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
      openai: { id: 'openai', capabilities: ['TEXT', 'EMBEDDING'] },
    })
  })

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

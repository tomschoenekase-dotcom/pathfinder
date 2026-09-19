import { describe, expect, it } from 'vitest'

import { resolveAiWorkloadConfiguration } from './workload-configuration'
import { AiRoutingError, routeAiCapability } from './capability-routing'

describe('AI capability routing', () => {
  it('routes a capability through central workload configuration', () => {
    const configuration = resolveAiWorkloadConfiguration({ workloadId: 'guest-chat' })
    expect(
      routeAiCapability({ capability: 'STANDARD', workloadId: 'guest-chat', configuration }),
    ).toMatchObject({
      capability: 'STANDARD',
      workloadId: 'guest-chat',
      candidates: [
        expect.objectContaining({
          provider: 'anthropic',
          modelKey: 'guest-chat',
          costTier: 'ECONOMY',
          fallback: false,
        }),
      ],
    })
  })

  it('rejects mismatched and premium-without-entitlement requests', () => {
    const configuration = resolveAiWorkloadConfiguration({ workloadId: 'guest-chat' })
    expect(() =>
      routeAiCapability({ capability: 'EMBEDDING', workloadId: 'guest-chat', configuration }),
    ).toThrow(
      new AiRoutingError('CAPABILITY_MISMATCH', 'guest-chat is not registered for EMBEDDING'),
    )
    expect(() =>
      routeAiCapability({
        capability: 'PREMIUM_CONVERSATION',
        workloadId: 'guest-chat',
        configuration,
      }),
    ).toThrow(new AiRoutingError('CAPABILITY_NOT_ENTITLED', 'PREMIUM_CONVERSATION is not entitled'))
  })

  it('rejects an effective configuration from another workload before routing', () => {
    const agentConfiguration = resolveAiWorkloadConfiguration({ workloadId: 'agent-run' })

    expect(() =>
      routeAiCapability({
        capability: 'STANDARD',
        workloadId: 'guest-chat',
        configuration: agentConfiguration,
      }),
    ).toThrow(
      new AiRoutingError(
        'CAPABILITY_MISMATCH',
        'Configuration for agent-run cannot route guest-chat',
      ),
    )
  })

  it('filters disabled providers and enforces economy mode', () => {
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: {
            fallback: { enabled: true, modelKeys: ['guest-chat-deepseek-pro'] },
          },
          unsafeChangesEnabled: true,
          reason: 'test fallback',
        },
      ],
    })
    expect(
      routeAiCapability({
        capability: 'STANDARD',
        workloadId: 'guest-chat',
        configuration,
        budgetPolicy: 'ECONOMY_ONLY',
      }).candidates,
    ).toHaveLength(1)
    expect(() =>
      routeAiCapability({
        capability: 'STANDARD',
        workloadId: 'guest-chat',
        configuration,
        disabledProviders: ['anthropic', 'deepseek'],
      }),
    ).toThrow(new AiRoutingError('NO_HEALTHY_ROUTE', 'No healthy STANDARD route is available'))
  })

  it('never dispatches a stale capability-incompatible candidate', () => {
    const withValidPrimary = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: { fallback: { enabled: true, modelKeys: ['agent-run'] } },
          unsafeChangesEnabled: true,
          reason: 'legacy incompatible fallback',
        },
      ],
    })
    expect(
      routeAiCapability({
        capability: 'STANDARD',
        workloadId: 'guest-chat',
        configuration: withValidPrimary,
      }).candidates.map((candidate) => candidate.modelKey),
    ).toEqual(['guest-chat'])

    const withOnlyInvalidPrimary = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: { primaryModelKey: 'agent-run' },
          unsafeChangesEnabled: true,
          reason: 'legacy incompatible primary',
        },
      ],
    })
    expect(() =>
      routeAiCapability({
        capability: 'STANDARD',
        workloadId: 'guest-chat',
        configuration: withOnlyInvalidPrimary,
      }),
    ).toThrow(
      new AiRoutingError('CAPABILITY_MISMATCH', 'No configured route is registered for STANDARD'),
    )
  })

  it('preserves explicit same-kind fallbacks for internal workload policy', () => {
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'answer-analysis',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'answer-analysis' },
          values: { fallback: { enabled: true, modelKeys: ['client-tochi'] } },
          unsafeChangesEnabled: true,
          reason: 'bounded internal text fallback',
        },
      ],
    })

    expect(
      routeAiCapability({
        capability: 'EXTRACTION',
        workloadId: 'answer-analysis',
        configuration,
      }).candidates.map((candidate) => candidate.modelKey),
    ).toEqual(['answer-analysis', 'client-tochi'])
  })

  it('routes a governed DeepSeek visitor-chat selection and honors health exclusion', () => {
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: { primaryModelKey: 'guest-chat-deepseek-flash' },
          unsafeChangesEnabled: true,
          reason: 'bounded DeepSeek canary',
        },
      ],
    })
    expect(
      routeAiCapability({ capability: 'STANDARD', workloadId: 'guest-chat', configuration }),
    ).toMatchObject({
      candidates: [
        { modelKey: 'guest-chat-deepseek-flash', provider: 'deepseek', model: 'deepseek-flash' },
      ],
    })
    expect(() =>
      routeAiCapability({
        capability: 'STANDARD',
        workloadId: 'guest-chat',
        configuration,
        unhealthyProviders: ['deepseek'],
      }),
    ).toThrow(new AiRoutingError('NO_HEALTHY_ROUTE', 'No healthy STANDARD route is available'))
  })
})

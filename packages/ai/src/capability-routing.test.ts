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

  it('filters disabled providers and enforces economy mode', () => {
    const configuration = resolveAiWorkloadConfiguration({
      workloadId: 'guest-chat',
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
          values: {
            fallback: { enabled: true, modelKeys: ['agent-run'] },
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
        disabledProviders: ['anthropic'],
      }),
    ).toThrow(new AiRoutingError('NO_HEALTHY_ROUTE', 'No healthy STANDARD route is available'))
  })
})

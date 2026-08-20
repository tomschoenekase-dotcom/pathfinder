import { afterEach, describe, expect, it, vi } from 'vitest'

import { setAnthropicClientForTesting } from './anthropic'
import { NOOP_AI_BUDGET_GATE } from './budget'
import { resolveAiWorkloadConfiguration } from './workload-configuration'
import { routeAiCapability } from './capability-routing'
import { generateTextForCapability } from './routed-generation'

describe('routed text generation', () => {
  afterEach(() => setAnthropicClientForTesting(null))

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
      budgetGate: NOOP_AI_BUDGET_GATE,
      onBeforeFirstDispatch: fence,
    })

    expect(result.route).toMatchObject({ modelKey: 'agent-run', fallbackUsed: true })
    expect(fence).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capability: 'STANDARD',
        requestType: 'guest-chat',
        routeModelKey: 'agent-run',
        fallbackUsed: true,
      }),
    )
  })
})

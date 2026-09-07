import { describe, expect, it } from 'vitest'

import { AI_CENTRAL_MODEL_REGISTRY } from './workload-configuration'
import { AI_INVENTORY_OMISSIONS, buildAiWorkloadInventory } from './workload-inventory'

describe('AI workload inventory', () => {
  it('reports only callable central routes and keeps unknown measurements unknown', () => {
    const inventory = buildAiWorkloadInventory({ anthropic: true, openai: false })
    expect(inventory).toHaveLength(Object.keys(AI_CENTRAL_MODEL_REGISTRY).length)
    expect(inventory.find((entry) => entry.workloadId === 'guest-chat')).toMatchObject({
      adapterCallable: true,
      providerConfiguration: 'CONFIGURED',
      configuredPricingEstimate: { version: expect.stringContaining('public-') },
      measured: { latencyMs: null, estimatedCostUsd: null, invoiceCostUsd: null },
    })
    expect(inventory.find((entry) => entry.workloadId === 'guest-query-embedding')).toMatchObject({
      adapterCallable: true,
      providerConfiguration: 'UNCONFIGURED',
    })
    expect(AI_INVENTORY_OMISSIONS).toEqual(
      expect.arrayContaining([
        expect.stringContaining('realtime voice'),
        expect.stringContaining('video/media'),
        expect.stringContaining('character generation'),
      ]),
    )
  })

  it('does not infer account access when provider configuration was not supplied', () => {
    expect(
      buildAiWorkloadInventory().every((entry) => entry.providerConfiguration === 'UNKNOWN'),
    ).toBe(true)
  })
})

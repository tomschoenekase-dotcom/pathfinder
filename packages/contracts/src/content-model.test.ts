import { describe, expect, it } from 'vitest'

import { ContentModule, groupContentModules } from './content-model'

const base = {
  venueId: 'venue-1',
  version: 1,
  audience: 'PUBLIC' as const,
  evidence: [
    {
      sourceId: 'source-1',
      locator: 'Hours section',
      capturedAt: '2026-08-11T18:00:00.000Z',
    },
  ],
}

describe('universal content modules', () => {
  it('keeps different content capabilities structurally distinct', () => {
    const place = ContentModule.parse({
      ...base,
      id: 'place-1',
      kind: 'PLACE',
      name: 'Welcome center',
      accessibility: ['Step-free entrance'],
    })
    const policy = ContentModule.parse({
      ...base,
      id: 'policy-1',
      kind: 'POLICY',
      title: 'Service animals',
      rule: 'Trained service animals are welcome.',
      appliesTo: ['place-1'],
    })

    expect(place.kind).toBe('PLACE')
    expect(policy.kind).toBe('POLICY')
    expect(groupContentModules([place, policy]).PLACE).toEqual([place])
    expect(groupContentModules([place, policy]).POLICY).toEqual([policy])
  })

  it('requires independently versioned, venue-scoped facts', () => {
    expect(
      ContentModule.safeParse({
        ...base,
        id: 'fact-1',
        version: 0,
        kind: 'OPERATIONAL_FACT',
        label: 'Last admission',
        value: '4:30 PM',
      }).success,
    ).toBe(false)
  })

  it('rejects self-referential relationships', () => {
    expect(
      ContentModule.safeParse({
        ...base,
        id: 'relationship-1',
        kind: 'RELATIONSHIP',
        fromId: 'place-1',
        toId: 'place-1',
        relationshipType: 'NEAR',
      }).success,
    ).toBe(false)
  })
})

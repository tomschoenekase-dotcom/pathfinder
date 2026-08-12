import { describe, expect, it } from 'vitest'

import {
  CreateGeneralizedContentInput,
  GeneralizedContentRevisionDraft,
  RetireGeneralizedContentInput,
} from './universal-content-actions'

const envelope = { audience: 'OPERATOR' as const, evidence: [] }

describe('generalized content action contracts', () => {
  it.each([
    {
      kind: 'ITEM',
      name: 'Apollo guidance computer',
      description: 'A preserved flight computer.',
      placeId: 'place-1',
      itemType: 'artifact',
    },
    { kind: 'SERVICE', name: 'Coat check' },
    { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
    {
      kind: 'EVENT',
      name: 'Late opening',
      startsAt: '2026-08-12T15:00:00.000Z',
      endsAt: '2026-08-12T16:00:00.000Z',
    },
    { kind: 'OPERATIONAL_FACT', label: 'Entrance', value: 'North door' },
    {
      kind: 'RELATIONSHIP',
      fromModuleId: 'module-a',
      toModuleId: 'module-b',
      relationshipType: 'NEAR',
    },
  ])('accepts a strict $kind payload', (payload) => {
    expect(GeneralizedContentRevisionDraft.parse({ ...envelope, payload })).toMatchObject({
      payload,
    })
  })

  it('bounds ITEM fields and rejects unknown payload data', () => {
    expect(() =>
      GeneralizedContentRevisionDraft.parse({
        ...envelope,
        payload: { kind: 'ITEM', name: 'x'.repeat(201), itemType: 'artifact' },
      }),
    ).toThrow()
    expect(() =>
      GeneralizedContentRevisionDraft.parse({
        ...envelope,
        payload: {
          kind: 'ITEM',
          name: 'Apollo guidance computer',
          itemType: 'artifact',
          internalNotes: 'never accepted',
        },
      }),
    ).toThrow()
  })

  it('requires a client-generated UUID creation key', () => {
    expect(() =>
      CreateGeneralizedContentInput.parse({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'not-a-uuid',
        draft: { ...envelope, payload: { kind: 'SERVICE', name: 'Coat check' } },
      }),
    ).toThrow()
  })

  it('rejects reversed effective windows, event windows, and self relationships', () => {
    expect(() =>
      GeneralizedContentRevisionDraft.parse({
        ...envelope,
        effectiveFrom: '2026-08-12T16:00:00.000Z',
        effectiveUntil: '2026-08-12T15:00:00.000Z',
        payload: { kind: 'SERVICE', name: 'Coat check' },
      }),
    ).toThrow()
    expect(() =>
      GeneralizedContentRevisionDraft.parse({
        ...envelope,
        payload: {
          kind: 'EVENT',
          name: 'Bad window',
          startsAt: '2026-08-12T16:00:00.000Z',
          endsAt: '2026-08-12T15:00:00.000Z',
        },
      }),
    ).toThrow()
    expect(() =>
      GeneralizedContentRevisionDraft.parse({
        ...envelope,
        payload: {
          kind: 'RELATIONSHIP',
          fromModuleId: 'same',
          toModuleId: 'same',
          relationshipType: 'NEAR',
        },
      }),
    ).toThrow()
  })

  it('requires a positive CAS for retirement and strict evidence hashes', () => {
    expect(() =>
      RetireGeneralizedContentInput.parse({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'module-1',
        expectedLatestVersion: 0,
        effectiveUntil: '2026-08-12T16:00:00.000Z',
        evidence: [],
      }),
    ).toThrow()
  })

  it('rejects duplicate evidence identities before persistence', () => {
    expect(() =>
      GeneralizedContentRevisionDraft.parse({
        audience: 'OPERATOR',
        evidence: [
          {
            sourceId: ' source-1 ',
            locator: 'Hours',
            capturedAt: '2026-08-11T18:00:00.000Z',
          },
          {
            sourceId: 'source-1',
            locator: 'Hours',
            capturedAt: '2026-08-11T19:00:00.000Z',
          },
        ],
        payload: { kind: 'SERVICE', name: 'Coat check' },
      }),
    ).toThrow(/unique by source and locator/i)
  })
})

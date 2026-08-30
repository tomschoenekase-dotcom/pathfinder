import { describe, expect, it } from 'vitest'

import { buildGuestCitations } from './guest-citations'

const candidate = {
  entityId: 'place-1',
  entityLabel: 'Elephant House',
  entityKind: 'place' as const,
  sourceType: 'official-website',
  sourceName: 'Official visitor guide',
  sourceUrl: 'https://museum.example/visit',
}

describe('guest citations', () => {
  it('projects deduplicated provenance only for explicitly named retrieved entities', () => {
    expect(
      buildGuestCitations({
        assistantResponse: 'The Elephant House is open today.',
        candidates: [candidate, candidate, { ...candidate, entityId: 'place-2' }],
      }),
    ).toEqual([
      {
        label: 'Official visitor guide',
        href: 'https://museum.example/visit',
        detail: 'Place: Elephant House',
      },
    ])
    expect(
      buildGuestCitations({ assistantResponse: 'The café is open.', candidates: [candidate] }),
    ).toEqual([])
    expect(
      buildGuestCitations({
        assistantResponse: 'Start here.',
        candidates: [{ ...candidate, entityLabel: 'Art' }],
      }),
    ).toEqual([])
  })

  it('keeps useful labels but drops credential-bearing URLs and unknown empty provenance', () => {
    expect(
      buildGuestCitations({
        assistantResponse: 'Read the Accessibility policy.',
        candidates: [
          {
            entityId: 'knowledge-1',
            entityLabel: 'Accessibility',
            entityKind: 'knowledge',
            sourceType: 'handbook',
            sourceName: 'Venue handbook',
            sourceUrl: 'https://example.org/private?token=secret',
          },
          {
            entityId: 'knowledge-2',
            entityLabel: 'Accessibility',
            entityKind: 'knowledge',
            sourceType: 'UNKNOWN',
            sourceName: null,
            sourceUrl: null,
          },
        ],
      }),
    ).toEqual([{ label: 'Venue handbook', detail: 'Venue knowledge: Accessibility' }])
  })
})

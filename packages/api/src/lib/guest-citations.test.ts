import { describe, expect, it } from 'vitest'

import { buildGuestCitations, selectGuestVisibleCitations } from './guest-citations'

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

describe('selectGuestVisibleCitations', () => {
  const stored = [
    {
      label: 'Grill dining',
      href: 'https://park.example/dining/grill/',
      detail: 'Venue knowledge: Grill: visitor information',
    },
    { label: 'Grill page', href: 'https://park.example/dining/grill/', detail: 'Place: Grill' },
    {
      label: 'Market dining',
      href: 'https://park.example/dining/market/',
      detail: 'Place: Market',
    },
    { label: 'Tickets', href: 'https://park.example/tickets/', detail: 'Venue knowledge: Tickets' },
    { label: 'Staff handbook', detail: 'Venue knowledge: Hours' },
  ]

  it.each([
    'What is there to eat?',
    'Rank the coasters in order of intensity',
    'Which rides are best for kids?',
    'Can I order food ahead on my phone?',
    'Can we drive the wildlife loop more than once on the same ticket?',
    'Does my ticket include parking?',
  ])('hides routine venue sources for %j', (visitorMessage) => {
    expect(selectGuestVisibleCitations({ visitorMessage, citations: stored })).toBeNull()
  })

  it.each(['Where can I get tickets?', 'Can you send me the ticket link?'])(
    'shows a ticket destination only when the visitor asks for one (%j)',
    (visitorMessage) => {
      const ticket = {
        label: 'Tickets',
        href: 'https://park.example/tickets/',
        detail: 'Venue knowledge: Tickets',
      }
      expect(selectGuestVisibleCitations({ visitorMessage, citations: [ticket] })).toEqual({
        heading: 'links',
        citations: [{ label: 'Tickets', ...ticket }],
      })
    },
  )

  it('shows at most two distinct linked destinations when the visitor asks for a page', () => {
    expect(
      selectGuestVisibleCitations({
        visitorMessage: 'Can I order ahead at the grill? Send the link',
        citations: stored,
      }),
    ).toEqual({
      heading: 'links',
      citations: [
        {
          label: 'Grill',
          href: 'https://park.example/dining/grill/',
          detail: 'Venue knowledge: Grill: visitor information',
        },
        { label: 'Market', href: 'https://park.example/dining/market/', detail: 'Place: Market' },
      ],
    })
  })

  it('keeps general web background attributed as sources', () => {
    const general = {
      label: 'General reference: Volcanoes',
      href: 'https://ref.example/volcano',
      detail: 'General background',
    }
    expect(
      selectGuestVisibleCitations({
        visitorMessage: 'How do volcanoes work?',
        citations: [...stored, general],
      }),
    ).toEqual({ heading: 'sources', citations: [general] })
  })
})

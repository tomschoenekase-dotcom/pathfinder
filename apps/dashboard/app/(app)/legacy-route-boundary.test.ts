import { beforeEach, describe, expect, it, vi } from 'vitest'

const redirect = vi.hoisted(() => vi.fn(() => undefined as never))
vi.mock('next/navigation', () => ({ redirect }))

import EngagementQuestionsPage from './engagement-questions/page'
import HelpPage from './help/page'
import EditVenuePage from './venues/[venueId]/edit/page'
import ImportVenuePage from './venues/[venueId]/import/page'
import VenueKnowledgePage from './venues/[venueId]/knowledge/page'
import EditPlacePage from './venues/[venueId]/places/[placeId]/edit/page'
import NewPlacePage from './venues/[venueId]/places/new/page'
import VenueQrKitPage from './venues/[venueId]/qr-kit/page'
import NewVenuePage from './venues/new/page'
import VenuesPage from './venues/page'

describe('ultra-simple client portal legacy route boundary', () => {
  beforeEach(() => redirect.mockClear())

  it.each([
    ['engagement authoring', () => EngagementQuestionsPage(), '/'],
    ['legacy help', () => HelpPage(), '/support'],
    ['venue directory', () => VenuesPage(), '/'],
    ['venue creation', () => NewVenuePage(), '/onboarding/setup'],
  ])('redirects %s without rendering internal tooling', (_name, renderRoute, destination) => {
    renderRoute()
    expect(redirect).toHaveBeenCalledWith(destination)
  })

  it.each([
    ['venue editing', () => EditVenuePage({ params: venueParams })],
    ['package import', () => ImportVenuePage({ params: venueParams })],
    ['knowledge editing', () => VenueKnowledgePage({ params: venueParams })],
    ['place creation', () => NewPlacePage({ params: venueParams })],
    [
      'place editing',
      () => EditPlacePage({ params: Promise.resolve({ venueId: 'venue-1', placeId: 'place-1' }) }),
    ],
    ['QR kit', () => VenueQrKitPage({ params: venueParams })],
  ])('redirects %s to the selected venue lifecycle home', async (_name, renderRoute) => {
    await renderRoute()
    expect(redirect).toHaveBeenCalledWith('/?venue=venue-1')
  })
})

const venueParams = Promise.resolve({ venueId: 'venue-1' })

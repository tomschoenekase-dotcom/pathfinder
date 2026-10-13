import type { GuestVenueDirectory } from '../guest-venue-directory'

/** Fictional stress fixture derived from the structure of a completed saved public snapshot.
 * No original names, identifiers, URLs or source prose are retained. The original snapshot has
 * three coasters among 27 ride topics, long safety paragraphs and paired minimum/maximum heights.
 * Extra fictional rides make card size and late consequential facts easy to exercise locally.
 */
export function largeGuestVenueFixture(count = 72): GuestVenueDirectory {
  return {
    incomplete: false,
    places: [],
    knowledge: Array.from({ length: count }, (_, i) => ({
      id: `fictional-ride-${i}`,
      title: `Lantern Ride ${i}`,
      category: 'Ride information',
      content: [
        `Lantern Ride ${i} is a ${i < 3 ? 'roller coaster' : 'family flat ride'}.`,
        'Made by: Fictional Engineering',
        'Height: 36 in minimum with a chaperone; 48 in unaccompanied; 76 in maximum.',
        'Size and speed: 85 ft physical ride height; 42 mph; 60-degree drop.',
        ...(i === 71 ? ['Operating status: Permanently closed.'] : []),
        'Rider requirements: Each child needing a chaperone needs a separate adult.',
        'Loose articles: Store phones and bags before boarding.',
        'Accessibility: Riders must transfer independently and use the restraint as designed.',
      ].join('\n'),
      sourceType: 'website_research',
      sourceName: 'Fictional Lantern Park',
      sourceUrl: `https://lantern.example/rides/${i}/`,
      updatedAt: new Date('2026-10-12T00:00:00Z'),
    })),
  }
}

import { describe, expect, it } from 'vitest'

import { VenuePackagePayload } from '../../schemas/venue-package'
import { venuePackageAuthoringFindings } from './authoring-checks'

/** Every venue, place and event here is fictional. */
const NOW = new Date('2026-10-27T15:00:00Z')

function topics(...contents: Array<string | [string, string]>) {
  return VenuePackagePayload.parse({
    schemaVersion: 1,
    places: [],
    knowledgeEntries: contents.map((content, index) =>
      Array.isArray(content)
        ? { title: content[0], category: 'Visiting', content: content[1] }
        : { title: `Topic ${index}`, category: 'Visiting', content },
    ),
  })
}

function codes(payload: VenuePackagePayload) {
  return venuePackageAuthoringFindings(payload, NOW).map((finding) => finding.code)
}

describe('venuePackageAuthoringFindings', () => {
  it('checks season dates in the dedicated hours field', () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      knowledgeEntries: [],
      places: [
        { name: 'Garden Tram', type: 'ride', hours: '10am-6pm daily, May 23 to August 16' },
        { name: 'River Boat', type: 'ride', hours: '10am-6pm daily, May 23 to August 16, 2026' },
        { name: 'Winter Walk', type: 'trail', hours: '10am-6pm, November 27 to December 19, 2026' },
      ],
    })
    expect(
      venuePackageAuthoringFindings(payload, NOW).map(({ code, path }) => [code, path]),
    ).toEqual([
      ['UNDATED_SEASON', 'places.0.hours'],
      ['STALE_DATE', 'places.1.hours'],
    ])
  })

  it('flags dates a visitor or the guide could read two ways', () => {
    expect(codes(topics('The park closes early on 7/4 for fireworks.'))).toEqual(['AMBIGUOUS_DATE'])
    expect(codes(topics('Fireworks start 10/11/26 at dusk.'))).toEqual(['AMBIGUOUS_DATE'])
    // Fractions, round-the-clock and unambiguous day-first numbers are not dates to fix.
    expect(
      codes(
        topics(
          'The trail is 1/2 mile long.',
          'Security is on site 24/7.',
          'Admission is 3/4 off for members.',
        ),
      ),
    ).toEqual([])
  })

  it('asks for a year on season and event dates, but not on fixed closures', () => {
    expect(codes(topics('Hours: 10am-6pm daily, May 23 to August 16'))).toEqual(['UNDATED_SEASON'])
    expect(codes(topics('The fall festival runs Fridays from September 25.'))).toEqual([
      'UNDATED_SEASON',
    ])
    expect(
      codes(
        topics(
          'Hours: 10am-6pm daily, May 22 to August 15, 2027',
          'Closed: December 25 and January 1',
        ),
      ),
    ).toEqual([])
  })

  it('flags a run that ended but reads as current, unless the record says it ended', () => {
    expect(
      codes(topics('Harvest Nights runs Fridays and Saturdays, September 25 to October 24, 2026.')),
    ).toEqual(['STALE_DATE'])
    expect(codes(topics('Lantern Nights runs Fridays, November 27 to December 19, 2025.'))).toEqual(
      ['STALE_DATE'],
    )
    expect(
      codes(
        topics(
          'Lantern Nights runs Fridays, November 27 to December 19, 2026.',
          'The 2026 season ended September 7. 2027 dates are not announced yet.',
          'Hours: 10am-7pm, May 23 to September 7, 2026\nThe 2026 season ended September 7, 2026.',
          'The mill was built in 1898 and opened in May 1899.',
        ),
      ),
    ).toEqual([])
  })

  it('flags placeholder facts and research placeholders', () => {
    expect(codes(topics('A day ticket covers all rides.\nPrice: TBD'))).toEqual([
      'PLACEHOLDER_FACT',
    ])
    expect(codes(topics('Height: unknown'))).toEqual(['PLACEHOLDER_FACT'])
    expect(codes(topics('The 2027 festival dates are TBA.'))).toEqual(['OPEN_ENDED_TIME'])
    expect(codes(topics('Closed: Mondays\nPrice: $5 per play'))).toEqual([])
  })

  it('flags two different values for one fact on a place', () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [
        {
          name: 'Cinderswing',
          type: 'pendulum ride',
          longDescription:
            'Cinderswing is a pendulum ride.\nHeight: 48 in to ride\nHeight: 52 in to ride',
        },
        {
          name: 'Ember Cafe',
          type: 'cafe',
          longDescription: 'Ember Cafe is a cafe.\nHours: 11am-3pm\nHours: 11am-3pm',
          hours: '11am-3pm daily',
        },
      ],
      knowledgeEntries: [],
    })
    const findings = venuePackageAuthoringFindings(payload, NOW)
    expect(findings.map((finding) => [finding.code, finding.path])).toEqual([
      ['CONFLICTING_FACT', 'places.0.longDescription'],
    ])
  })

  it('flags facts in the hours field and things that are not hours', () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [
        { name: 'Cinderswing', type: 'ride', hours: '10am-6pm, $5 per ride' },
        { name: 'Ember Cafe', type: 'cafe', hours: 'Ask staff' },
        { name: 'Lookout', type: 'viewpoint', hours: 'Open daily' },
      ],
      knowledgeEntries: [],
    })
    expect(
      venuePackageAuthoringFindings(payload, NOW).map((finding) => [finding.code, finding.path]),
    ).toEqual([
      ['MISPLACED_FACT', 'places.0.hours'],
      ['MISPLACED_FACT', 'places.1.hours'],
    ])
  })

  it('flags one caution copied into many records, and near-duplicate topics', () => {
    const caution = 'Please call ahead before visiting because hours can change without notice.'
    expect(
      codes(
        topics(
          ['Parking', `Parking is free. ${caution}`],
          ['Dining', `The cafe serves lunch. ${caution}`],
          ['Trails', `The trail is paved. ${caution}`],
        ),
      ),
    ).toEqual(['REPEATED_TEXT'])
    expect(
      codes(topics(['Parking', 'Parking is free.'], ['Parking information', 'Lot B is free.'])),
    ).toEqual(['NEAR_DUPLICATE_TOPIC'])
    expect(
      codes(topics(['Parking', 'Parking is free.'], ['Bus parking', 'Buses use Lot C.'])),
    ).toEqual([])
  })

  it('flags claims and facts placed in voice notes', () => {
    expect(codes(topics("Cinderswing is the world's largest pendulum ride."))).toEqual([
      'UNSUPPORTED_CLAIM',
    ])
    const notes = VenuePackagePayload.parse({
      schemaVersion: 2,
      venue: {
        aiBehavior: { aiGuideNotes: 'Remind guests that parking is $10 and we close at 6pm.' },
      },
    })
    expect(codes(notes)).toEqual(['FACT_IN_VOICE_NOTES'])
    const voice = VenuePackagePayload.parse({
      schemaVersion: 2,
      venue: {
        aiBehavior: { aiGuideNotes: 'Speak like a cheerful park ranger. Keep answers short.' },
      },
    })
    expect(codes(voice)).toEqual([])
  })

  it('reads only records a visitor can see', () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [
        { title: 'Old', category: 'Visiting', content: 'Price: TBD', isEnabled: false },
      ],
    })
    expect(codes(payload)).toEqual([])
  })
})

describe('false-positive guards found on real packages', () => {
  it('uses the actual start month for an abbreviated range, not modal words or an earlier date', () => {
    const duringRun = new Date('2026-10-20T15:00:00Z')
    for (const content of [
      'The festival may run October 1 to 24, 2026.',
      'Tickets go on sale May 1, 2026; the festival runs October 1 to 24, 2026.',
    ]) {
      expect(venuePackageAuthoringFindings(topics(content), duringRun)).toEqual([])
      expect(codes(topics(content))).toEqual(['STALE_DATE'])
    }
  })

  it('does not silently treat a date after a calendar cue as a fraction', () => {
    expect(codes(topics('The festival opens on 1/2.'))).toEqual(['AMBIGUOUS_DATE'])
    expect(codes(topics('Hours: 10am-6pm on 3/4.'))).toEqual(['AMBIGUOUS_DATE'])
    expect(codes(topics('The trail is 1/2 mile long.'))).toEqual([])
  })

  it('accepts historic years, negated guarantees and fixed holiday closure lists', () => {
    expect(
      codes(
        topics(
          'The rider left on April 18-19, 1775, to warn the town.',
          'Joining the waitlist does not guarantee a place.',
          "Holiday closures: New Year's Day, Memorial Day, Independence Day and December 25.",
        ),
      ),
    ).toEqual([])
    expect(codes(topics('Maintenance closure: October 6-10; the zoo reopens October 11.'))).toEqual(
      ['UNDATED_SEASON'],
    )
  })
})

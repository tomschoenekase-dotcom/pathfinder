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
      // During the run it is not stale, but it ends within three weeks.
      expect(
        venuePackageAuthoringFindings(topics(content), duringRun).map((finding) => finding.code),
      ).toEqual(['EXPIRES_SOON'])
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

  it('treats every negated guarantee as a caution, however it is worded', () => {
    expect(
      codes(
        topics(
          'Ask staff about ingredients; a menu label is not an allergy-safety guarantee.',
          'Animals choose where to rest, so no particular sighting is guaranteed.',
          'Keeper talks are part of animal care rather than guaranteed performances.',
          'Neither a parking space nor a reserved seat is guaranteed.',
        ),
      ),
    ).toEqual([])
    expect(codes(topics('Every guest is guaranteed a front-row seat.'))).toEqual([
      'UNSUPPORTED_CLAIM',
    ])
  })
})

describe('time-limited facts that package records keep forever', () => {
  it('asks for the date on a status that is only true for a while', () => {
    expect(
      codes(
        topics(
          'Lantern Carousel is a wooden carousel, closed for the season.',
          'Otter Bend Gift Stop is a souvenir shop, temporarily closed.',
          'Heron House is a bird building currently undergoing renovation.',
        ),
      ),
    ).toEqual(['UNDATED_STATUS', 'UNDATED_STATUS', 'UNDATED_STATUS'])
    expect(
      codes(
        topics(
          'Lantern Carousel is a wooden carousel. It closed for the 2026 season on October 25, 2026.',
          'The 2026 splash season ended September 7, 2026. That season has ended, so the pad is dry.',
        ),
      ),
    ).toEqual([])
  })

  it('flags dates that are right only on the day they were written', () => {
    expect(codes(topics('Pumpkin Days returns next year with a larger corn maze.'))).toEqual([
      'RELATIVE_DATE',
    ])
    expect(codes(topics('Pumpkin Days returns in September 2027.'))).toEqual([])
  })

  it('reports a record whose last date passes within three weeks, but not an open-ended start', () => {
    // NOW is October 27, 2026.
    expect(
      codes(topics('Harvest Market runs weekends, October 3 to November 1, 2026, 10am-4pm.')),
    ).toEqual(['EXPIRES_SOON'])
    expect(codes(topics('Stargazing Night is on November 6, 2026, from 7pm.'))).toEqual([
      'EXPIRES_SOON',
    ])
    // "historical" describing a tour is not "this has ended".
    expect(
      codes(topics('Lantern History Walk is a historical walking tour on November 2, 2026.')),
    ).toEqual(['EXPIRES_SOON'])
    expect(
      codes(
        topics(
          'From November 1, 2026, the cafe opens 11am-3pm daily.',
          'Winter Lights runs November 20, 2026 to January 3, 2027.',
          'Ice skating resumes Saturday, November 14, 2026.',
        ),
      ),
    ).toEqual([])
  })

  it('reports a single past date that does not say it passed, but not history', () => {
    expect(codes(topics('The members preview is on October 20, 2026, 5-8pm.'))).toEqual([
      'STALE_DATE',
    ])
    expect(
      codes(
        topics(
          'Two otter pups were born June 10, 2026, and now explore the pool.',
          'The aviary opened August 20, 2026.',
          'The members preview on October 20, 2026 has passed.',
          'The boathouse was dedicated on May 1, 1934.',
        ),
      ),
    ).toEqual([])
  })

  it('does not read the end of a year as a day before a number', () => {
    // "26" in "2026, 1912 Grill" is not a day; this record runs to November 1, 2026.
    const during = new Date('2026-10-28T15:00:00Z')
    expect(
      venuePackageAuthoringFindings(
        topics('Through November 1, 2026, 1912 Grill is closed Tuesdays.'),
        during,
      ).map((finding) => finding.code),
    ).toEqual(['EXPIRES_SOON'])
  })
})

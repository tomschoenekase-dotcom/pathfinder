import type {
  GuestDirectoryKnowledge,
  GuestDirectoryPlace,
  GuestVenueDirectory,
} from '../guest-venue-directory'

// Fictional authoring data, deliberately independent of venue evaluation/holdout corpora.
export function createLargeVenueDisclosureFixture() {
  const currentDate = '2026-10-25'
  const venueName = 'Copper Meadow Park'
  const copiedHours = 'Hours: Open 10 AM to 6 PM during the main season; check the daily calendar.'
  const caution =
    "Opening and closing times for your visit date are unconfirmed. Confirm the dated operating calendar before travelling; the copied ride Hours lines do not establish that day's schedule."
  const hoursSummary: GuestDirectoryKnowledge = {
    id: 'fictional-hours-summary',
    title: 'Hours and operating calendar',
    category: 'Hours',
    content:
      'Park opening hours vary with the operating calendar.\n' +
      'CONFLICTED: The main-season page lists 10 AM to 6 PM, while the dated calendar lists 11 AM to 5 PM.\n' +
      caution,
    sourceType: 'FOUNDER_PROVIDED',
    sourceName: 'Fictional park authoring fixture',
    sourceUrl: null,
  }
  const places: GuestDirectoryPlace[] = []
  const knowledge: GuestDirectoryKnowledge[] = []
  for (let index = 0; index < 90; index++) {
    const name = index === 0 ? 'Copper Comet' : `Meadow Circuit ${String(index).padStart(3, '0')}`
    const description = `${name} is a gentle circular ride beside the meadow promenade.`
    const details = [
      'The queue winds around a planted courtyard, with benches beside the entrance and a shaded waiting section near the platform.',
      'Each vehicle has a padded bench and a lap bar. A small storage shelf beside the platform holds loose belongings during the trip.',
      'The route passes painted scenery, miniature bridges and garden beds. Passengers can see the meadow from the highest bend.',
      'The exit returns to the promenade beside the entrance. Families can meet at the painted sign without crossing the boarding lane.',
      'A level path leads to the entrance courtyard. Staff at the platform can describe the boarding steps and vehicle seating.',
      'The nearby seating terrace has tables and a drinking fountain. The ride itself has no food service or souvenir counter.',
      'The painted vehicles each feature a different meadow flower. Decorative lanterns line the fence around the track.',
      'Visitors waiting for friends can watch the vehicles from the public promenade outside the low wooden fence.',
      'A covered noticeboard beside the entrance explains the seating arrangement and shows the route through the garden.',
      'The surrounding courtyard connects to the central lawn, picnic terrace and north garden by broad paved walking paths.',
    ].join('\n')
    places.push({
      id: `fictional-place-${index}`,
      name,
      type: 'ride',
      itemType: 'activity',
      shortDescription: description,
      longDescription: 'Board at the meadow promenade and return to the same courtyard.',
      lat: null,
      lng: null,
      tags: ['family ride'],
      areaName: 'Meadow Promenade',
      hours: null,
      photoUrl: null,
      sourceType: 'FOUNDER_PROVIDED',
      sourceName: 'Fictional park authoring fixture',
      sourceUrl: null,
    })
    knowledge.push({
      id: `fictional-ride-topic-${index}`,
      title: name,
      category: 'Rides',
      content: `${description}\n${details}\n${copiedHours}`,
      sourceType: 'FOUNDER_PROVIDED',
      sourceName: 'Fictional park authoring fixture',
      sourceUrl: null,
    })
  }
  // Put the governing summary after all copied ride schedules, as in a large imported package.
  knowledge.push(hoursSummary)
  const directory: GuestVenueDirectory = { places, knowledge, incomplete: false }
  return { currentDate, venueName, directory, copiedHours, hoursSummary, caution }
}

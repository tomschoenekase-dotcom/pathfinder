type RelevantPlace = {
  name: string
  type: string
  shortDescription: string | null
  longDescription: string | null
  distanceMeters: number
  areaName: string | null
  tags: string[]
  hours: string | null
}

type VenueInfo = {
  name: string
  description: string | null
  category: string | null
  guideNotes?: string | null
}

export function buildVenueSystemPrompt(params: {
  venue: VenueInfo
  relevantPlaces: RelevantPlace[]
  userLat: number
  userLng: number
}): string {
  const { venue, relevantPlaces, userLat, userLng } = params

  const venueDescription = venue.description ?? 'A venue with many things to explore.'
  const guideNotesSection = venue.guideNotes ? `\nVenue guide notes:\n${venue.guideNotes}` : ''

  const placesSection =
    relevantPlaces.length === 0
      ? 'No specific points of interest have been configured yet.'
      : relevantPlaces
          .map((p, i) => {
            const distance = Math.round(p.distanceMeters)
            const area = p.areaName ? ` in ${p.areaName}` : ''
            const desc = p.shortDescription ? `\n   ${p.shortDescription}` : ''
            const detail = p.longDescription ? `\n   Details: ${p.longDescription}` : ''
            const tags = p.tags.length > 0 ? `\n   Tags: ${p.tags.join(', ')}` : ''
            const hours = `\n   Hours: ${p.hours ?? 'not specified'}`
            return `${i + 1}. ${p.name} (${p.type}) — ${distance}m away${area}${desc}${detail}${tags}${hours}`
          })
          .join('\n\n')

  return `You are Path Finder, a helpful on-site guide for ${venue.name}.

About this venue:
${venueDescription}${guideNotesSection}

The visitor is currently at coordinates (${userLat}, ${userLng}).

MOST RELEVANT PLACES FOR THIS QUERY:
${placesSection}

Rules:
- Ground every answer in the venue data above. Do not invent places or distances.
- Always mention proximity when relevant ("You're about 50 meters from...").
- Keep answers short — 2 to 3 sentences max. Visitors are on foot reading on a phone.
- For practical questions (bathroom, food, seating), give the nearest match and nothing else.
- For exploratory questions, suggest one or two options with a brief reason.
- Never use markdown, bullet points, asterisks, or headers. Plain conversational text only.
- Never reveal internal data like scores or IDs.`
}

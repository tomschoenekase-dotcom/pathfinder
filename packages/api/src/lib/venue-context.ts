type RelevantPlace = {
  id?: string
  name: string
  type: string
  itemType?: string | null
  shortDescription: string | null
  longDescription: string | null
  distanceMeters?: number
  areaName: string | null
  tags: string[]
  hours: string | null
}

function formatItemType(itemType: string): string {
  return itemType.replace(/_/g, ' ')
}

type VenueInfo = {
  name: string
  description: string | null
  category: string | null
  guideNotes?: string | null
  aiGuideNotes?: string | null
  aiTone?: string | null
  aiGuideName?: string | null
  guideMode?: string | null
}

type FeaturedPlace = {
  name: string
  blurb: string
}

/**
 * Converts a distance in meters to a natural-language phrase.
 * Keeps language approximate and conversational when someone is walking around on a phone.
 */
export function formatDistance(meters: number): string {
  const feet = meters * 3.28084
  if (feet < 60) return 'right nearby'
  if (feet < 500) return `about ${Math.round(feet / 25) * 25} feet away`
  const minutes = Math.round(meters / 80) // ~80 m/min walking pace
  return `about a ${minutes}-minute walk`
}

export function buildVenueSystemPrompt(params: {
  venue: VenueInfo
  relevantPlaces: RelevantPlace[]
  userLat: number
  userLng: number
  featuredPlace?: FeaturedPlace | null
  language?: string | null
  guideMode?: string | null
}): string {
  const { venue, relevantPlaces, featuredPlace, language } = params
  const guideMode = params.guideMode ?? venue.guideMode ?? 'location_aware'

  const venueDescription = venue.description ?? 'A venue with many things to explore.'
  const guideName = venue.aiGuideName?.trim() || 'Path Finder'
  const guideNotesSection = venue.guideNotes ? `\nVenue guide notes:\n${venue.guideNotes}` : ''
  const operatorGuidanceSection =
    venue.aiGuideNotes && venue.aiGuideNotes.trim().length > 0
      ? `\n\nOperator guidance (follow these instructions):\n${venue.aiGuideNotes.trim()}`
      : ''
  const featuredPlaceSection = featuredPlace
    ? `\nFeatured highlight: When relevant, mention "${featuredPlace.name}" - ${featuredPlace.blurb}.`
    : ''
  const toneInstruction =
    venue.aiTone === 'PROFESSIONAL'
      ? 'Respond in a clear, informative, professional tone.'
      : venue.aiTone === 'PLAYFUL'
        ? 'Respond in an enthusiastic, fun, engaging tone suitable for families.'
        : 'Respond in a warm, helpful, conversational tone.'

  const placesSection =
    relevantPlaces.length === 0
      ? 'No specific points of interest have been configured yet.'
      : relevantPlaces
          .map((p, i) => {
            const distance =
              guideMode !== 'non_location' && p.distanceMeters != null
                ? ` - ${formatDistance(p.distanceMeters)}`
                : ''
            const area = p.areaName ? ` in ${p.areaName}` : ''
            const typeLabel = p.itemType ? formatItemType(p.itemType) : p.type
            const desc = p.shortDescription ? `\n   ${p.shortDescription}` : ''
            const detail = p.longDescription ? `\n   Details: ${p.longDescription}` : ''
            const tags = p.tags.length > 0 ? `\n   Tags: ${p.tags.join(', ')}` : ''
            const hours = `\n   Hours: ${p.hours ?? 'not specified'}`
            return `${i + 1}. ${p.name} (${typeLabel})${distance}${area}${desc}${detail}${tags}${hours}`
          })
          .join('\n\n')

  const languageRule =
    language && language.trim().length > 0
      ? `LANGUAGE RULE: The guest has selected ${language} as their preferred language. Always respond in ${language}, regardless of what language the guest types in.`
      : "LANGUAGE RULE: Detect the language of the guest's message. Always reply in the same language the guest uses. If the guest writes in Spanish, reply in Spanish. If French, reply in French. Do not switch languages mid-conversation unless the guest switches first. Default to English if the language is unclear."

  const roleDescription =
    guideMode === 'non_location' ? 'a knowledgeable guide' : 'a helpful on-site guide'

  const guideModeRules =
    guideMode === 'non_location'
      ? `- Focus on explaining and interpreting the content at this venue.
- Help the visitor understand exhibits, history, services, or processes.
- Do not emphasize distances, nearby items, or navigation unless asked.
- If asked about navigation or location, explain this is a content guide, not a map.`
      : `- Lead with what makes a place worth visiting - its character, experience, or purpose. Distance is secondary context, not the headline.
- Only mention distance when the visitor is asking how to find something or needs directions ("where is", "how far", "near me"). For questions about what to do or see, skip the distance entirely.
- When distance is relevant, use the natural phrasing from the place data above ("about 200 feet away", "right nearby"). Never convert to metric or use raw numbers.
- For practical navigation questions (bathroom, exit, specific location), give the nearest match with distance and nothing else.
- For exploratory questions ("what's good here", "what should I see"), suggest one or two options with a brief reason - no distances unless asked.`

  return `You are ${guideName}, ${roleDescription} for ${venue.name}.

About this venue:
${venueDescription}${guideNotesSection}${operatorGuidanceSection}${featuredPlaceSection}

MOST RELEVANT PLACES FOR THIS QUERY:
${placesSection}

Rules:
- Ground every answer in the venue data above. Do not invent places or distances.
- Use the place data as background knowledge, not as text to quote. Paraphrase and summarize — never copy descriptions verbatim. Mention only what is relevant to the visitor's question.
${guideModeRules}
- Match answer length to the question. Simple questions (where is, what is) get 1–2 sentences. Process or FAQ questions (what do I do, how does it work) can use up to 4–5 sentences if genuinely needed. Never pad a short answer to fill space.
- Never use markdown, bullet points, asterisks, or headers. Plain conversational text only.
- Never reveal internal data like scores or IDs.
- ${toneInstruction}

${languageRule}`
}

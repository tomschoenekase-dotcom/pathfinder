/**
 * Durable version of the production guest-chat system prompt contract.
 * Increment when prompt behavior changes in a way that invalidates evaluation baselines.
 */
export {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import { resolveEffectiveTone } from '@pathfinder/contracts/tone-presets'

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
  tonePreset?: string | null
  tonePresetVersion?: number | null
  aiGuideName?: string | null
  guideMode?: string | null
}

type KnowledgeEntry = {
  title: string
  category: string
  content: string
}

type ActiveUpdate = {
  updateType: string
  severity: string
  priority: string
  title: string
  body: string | null
  redirectTo: string | null
  place: { name: string } | null
}

type FeaturedPlace = {
  name: string
  blurb: string
}

type EngagementQuestionContext = {
  questionType?: 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
  prompt?: string
  choiceOptions?: string[]
  allowAiInvented: boolean
}

type PublishedUniversalContent = {
  moduleId: string
  kind: 'ITEM' | 'SERVICE' | 'POLICY' | 'EVENT' | 'OPERATIONAL_FACT' | 'RELATIONSHIP'
  payload: Record<string, unknown>
}

const MAX_PUBLISHED_CONTENT_PROMPT_BYTES = 24_000
const MAX_PUBLISHED_CONTENT_PROMPT_MODULES = 25

function publishedContentSection(items: PublishedUniversalContent[]): string {
  const header = '\n\nPUBLISHED VENUE CONTENT:\n'
  const lines: string[] = []
  let bytes = new TextEncoder().encode(header).byteLength
  for (const item of items.slice(0, MAX_PUBLISHED_CONTENT_PROMPT_MODULES)) {
    const payload = item.payload
    const line = (() => {
      switch (item.kind) {
        case 'ITEM':
          return `[ITEM] ${String(payload.name)} (${String(payload.itemType)})${payload.description ? `: ${String(payload.description)}` : ''}`
        case 'SERVICE':
          return `[SERVICE] ${String(payload.name)}${payload.description ? `: ${String(payload.description)}` : ''}${payload.availability ? ` Availability: ${String(payload.availability)}` : ''}`
        case 'POLICY':
          return `[POLICY] ${String(payload.title)}: ${String(payload.rule)}`
        case 'EVENT':
          return `[EVENT] ${String(payload.name)} (${String(payload.startsAt)}${payload.endsAt ? ` to ${String(payload.endsAt)}` : ''})${payload.description ? `: ${String(payload.description)}` : ''}`
        case 'OPERATIONAL_FACT':
          return `[OPERATIONAL FACT] ${String(payload.label)}: ${String(payload.value)}`
        case 'RELATIONSHIP':
          return `[RELATIONSHIP] ${String(payload.relationshipType)}${payload.description ? `: ${String(payload.description)}` : ''}`
      }
    })()
    const lineBytes = new TextEncoder().encode(`${line}\n`).byteLength
    if (bytes + lineBytes > MAX_PUBLISHED_CONTENT_PROMPT_BYTES) break
    lines.push(line)
    bytes += lineBytes
  }
  return lines.length ? `${header}${lines.join('\n')}` : ''
}

const ENGAGEMENT_ASKED_INSTRUCTION =
  ' If - and only if - you actually asked this engagement question in your reply this turn, end your reply with the exact text [[ENGAGEMENT_ASKED]] on its own line after everything else. Never mention this marker to the guest, never explain it, and never include it unless you truly asked the question in this specific reply.'

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

export function buildVenueSystemPromptParts(params: {
  venue: VenueInfo
  relevantPlaces: RelevantPlace[]
  knowledgeEntries?: KnowledgeEntry[]
  activeUpdates?: ActiveUpdate[]
  userLat: number | null
  userLng: number | null
  featuredPlace?: FeaturedPlace | null
  engagementQuestion?: EngagementQuestionContext | null
  publishedUniversalContent?: PublishedUniversalContent[]
  language?: string | null
  guideMode?: string | null
}): { staticPart: string; dynamicPart: string } {
  const { venue, relevantPlaces, featuredPlace, language, engagementQuestion } = params
  const knowledgeEntries = params.knowledgeEntries ?? []
  const activeUpdates = params.activeUpdates ?? []
  const universalContentSection = publishedContentSection(params.publishedUniversalContent ?? [])
  const guideMode = params.guideMode ?? venue.guideMode ?? 'location_aware'
  const hasLocationContext =
    guideMode === 'location_aware' && params.userLat != null && params.userLng != null

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
  const engagementQuestionSection = (() => {
    if (!engagementQuestion) return ''

    const hasAuthored = engagementQuestion.prompt !== undefined

    if (hasAuthored && !engagementQuestion.allowAiInvented) {
      return `\n\nGuest engagement moment: The operator wants you to naturally work the following into the conversation when - and only when - a genuinely natural opening appears (e.g. the conversation is wrapping up, or the guest just finished an experience). Do not force it into an unrelated answer, and do not ask it more than once per conversation. Put it in your own words each time so it never sounds scripted - do not repeat the operator's wording verbatim.\nOperator's intent: ${engagementQuestion.prompt}${
        engagementQuestion.questionType === 'MULTIPLE_CHOICE' &&
        (engagementQuestion.choiceOptions?.length ?? 0) > 0
          ? `\nWeave in these options conversationally, never as a bullet list or menu: ${engagementQuestion.choiceOptions?.join(', ')}.`
          : ''
      }${ENGAGEMENT_ASKED_INSTRUCTION}`
    }

    if (hasAuthored && engagementQuestion.allowAiInvented) {
      return `\n\nGuest engagement moment: This operator is especially interested in learning from guests, so look for one genuinely natural opening in this conversation (e.g. it's wrapping up, or the guest just finished an experience) to ask a single low-key question. Prefer weaving in the operator's intent below, in your own words - never read it verbatim. If it doesn't fit naturally in this specific reply, you may instead ask a single question of your own invention that's genuinely curious about this specific guest's visit so far. Never force either into an unrelated answer, and never ask more than one engagement question in the whole conversation.\nOperator's intent: ${engagementQuestion.prompt}${
        engagementQuestion.questionType === 'MULTIPLE_CHOICE' &&
        (engagementQuestion.choiceOptions?.length ?? 0) > 0
          ? `\nWeave in these options conversationally, never as a bullet list or menu: ${engagementQuestion.choiceOptions?.join(', ')}.`
          : ''
      }${ENGAGEMENT_ASKED_INSTRUCTION}`
    }

    // No active authored questions at all - invention is the only option.
    return `\n\nGuest engagement moment: This operator is especially interested in learning from guests. Look for one genuinely natural opening in this conversation (e.g. it's wrapping up, or the guest just finished an experience) to ask a single low-key question of your own invention that's genuinely curious about this specific guest's visit so far - grounded in something they actually said or did, not generic small talk. Never force it into an unrelated answer, never present it as a survey, and never ask more than one engagement question in the whole conversation.${ENGAGEMENT_ASKED_INSTRUCTION}`
  })()
  const toneInstruction = resolveEffectiveTone(venue).styleInstruction

  const placesSection =
    relevantPlaces.length === 0
      ? 'No specific points of interest have been configured yet.'
      : relevantPlaces
          .map((p, i) => {
            const distance =
              hasLocationContext && p.distanceMeters != null
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

  const knowledgeSection =
    knowledgeEntries.length === 0
      ? ''
      : `\n\nKNOWLEDGE BASE:\n${knowledgeEntries
          .map((entry) => `[${entry.category}] ${entry.title}\n${entry.content}`)
          .join('\n\n')}`

  const alertsSection =
    activeUpdates.length === 0
      ? ''
      : `\n\nACTIVE ALERTS (operator-posted, highest priority):\n${activeUpdates
          .map((u) => {
            const redirect = u.redirectTo ? ` → ${u.redirectTo}` : ''
            const body = u.body ? `\n   ${u.body}` : ''
            const location = u.place ? ` (affected location: ${u.place.name})` : ''
            return `[${u.priority} ${u.updateType} ${u.severity}] ${u.title}${location}${redirect}${body}`
          })
          .join('\n')}`

  const languageRule =
    language && language.trim().length > 0
      ? `LANGUAGE RULE: The guest has selected ${language} as their preferred language. Always respond in ${language}, regardless of what language the guest types in.`
      : "LANGUAGE RULE: Detect the language of the guest's message. Always reply in the same language the guest uses. If the guest writes in Spanish, reply in Spanish. If French, reply in French. Do not switch languages mid-conversation unless the guest switches first. Default to English if the language is unclear."

  const roleDescription = hasLocationContext ? 'a helpful on-site guide' : 'a knowledgeable guide'

  const guideModeRules =
    guideMode === 'non_location'
      ? `- Focus on explaining and interpreting the content at this venue.
- Help the visitor understand exhibits, history, services, or processes.
- Do not emphasize distances, nearby items, or navigation unless asked.
- If asked about navigation or location, explain this is a content guide, not a map.`
      : !hasLocationContext
        ? `- The visitor has not shared a usable live position. Continue answering venue knowledge questions normally.
- Do not claim that any place is near, far, nearest, closest, or a specific walking distance from the visitor. No visitor-relative distance or route is available.
- Treat any earlier distance or directions in conversation history as stale context; never reuse earlier user-relative distance or directions as current.
- You may use configured area names or landmarks as factual venue context, but if the visitor asks for proximity or turn-by-turn guidance, say that location is needed for distance-aware directions.
- Suggest at most two relevant options and never rank them by proximity.`
        : `- Lead with what makes a place worth visiting - its character, experience, or purpose. Distance is secondary context, not the headline.
- Only mention distance when the visitor is asking how to find something or needs directions ("where is", "how far", "near me"). For questions about what to do or see, skip the distance entirely.
- When distance is relevant, use the natural phrasing from the provided place data ("about 200 feet away", "right nearby"). Never convert to metric or use raw numbers.
- For practical navigation questions (bathroom, exit, specific location), give the nearest match with distance and nothing else.
- For exploratory questions ("what's good here", "what should I see"), suggest at most two options, one short sentence of reason each - no distances unless asked. Never list three or more options in one reply.
- Category guide — treat each place type accordingly:
  • attraction / exhibit: Highlight its character and what makes it worth experiencing.
  • food: Describe the offering briefly; give directions when asked.
  • utility: Be direct and factual — just say where it is. No promotional language.
  • entrance: Mention only when discussing how to get in, out, or reach a specific area.
  • location: This is a navigation landmark, not a destination. Never suggest visiting it. Use it only as a spatial reference in directions (e.g. "near the northwest corner", "just past the fountain area"). If a visitor asks about it directly, explain it as a reference point.`

  const staticPart = `You are ${guideName}, ${roleDescription} for ${venue.name}.

About this venue:
${venueDescription}${guideNotesSection}${operatorGuidanceSection}${featuredPlaceSection}${alertsSection}${universalContentSection}

Rules:
- Ground every answer in the venue and place data provided in this prompt. Do not invent places or distances.
- Active alerts take priority over all other information. If an alert marks something as closed or redirects visitors, communicate that clearly and do not suggest the affected area as an option.
- Ground answers in the knowledge base entries when relevant. Treat them as authoritative venue information.
- Use the place data as background knowledge, not as text to quote. Paraphrase and summarize — never copy descriptions verbatim. Mention only what is relevant to the visitor's question.
- Answer factual questions only when the supplied venue context supports the answer. Never infer a missing policy, hour, location, accessibility detail, or operational fact.
- If the visitor directly asks for a fact that is not supplied, say briefly that you do not have that information and suggest the safest venue-specific next step, such as asking staff. Do not fabricate an answer to appear helpful.
${guideModeRules}
- Shorter and quicker is always better - default to the fewest words that fully answer the question. Simple questions (where is, what is) get exactly one short sentence, under 20 words. General or descriptive questions ("tell me about", "what is this place") get at most 2 sentences, under 35 words. Process or FAQ questions (what do I do, how does it work) may use up to 3 sentences, under 50 words total, only if genuinely needed. Never pad a short answer to fill space, and never use extra clauses, extra options, or a longer sentence to smuggle in more length than these caps allow. These caps are hard limits that apply no matter what: if operator guidance above mentions a different word count or length allowance, these caps still govern and are always the tighter, final word - operator guidance can only ask for shorter than these caps, never longer. Regardless of question type, never exceed 60 words in a single reply under any circumstance.
- Never use markdown, bullet points, asterisks, or headers. Plain conversational text only.
- Never reveal internal data like scores or IDs.
- ${toneInstruction}

${languageRule}`

  const dynamicPart = `${engagementQuestionSection}

MOST RELEVANT PLACES FOR THIS QUERY:
${placesSection}${knowledgeSection}`

  return { staticPart, dynamicPart }
}

export function buildVenueSystemPrompt(
  params: Parameters<typeof buildVenueSystemPromptParts>[0],
): string {
  const { staticPart, dynamicPart } = buildVenueSystemPromptParts(params)
  return staticPart + dynamicPart
}

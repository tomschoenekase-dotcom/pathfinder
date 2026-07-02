# Task Packet: Chat System Prompt — Cache-Friendly Reordering

## Why this exists

`packages/api/src/lib/venue-context.ts` builds the guest-chat system prompt as
one big string, and `packages/api/src/routers/chat.ts` sends it as a single
`system` block with `cache_control: { type: 'ephemeral' }`. Anthropic's prompt
caching is a **prefix match** — everything up to a cache breakpoint is cached
as one unit, and the _entire_ unit must match byte-for-byte on the next
request for a cache read to happen.

Today, the fully static part of the prompt (venue description, guide notes,
operator guidance, the "Rules" block, tone, language) is concatenated into the
**same block** as the per-query "MOST RELEVANT PLACES" section, which is
retrieval-based and differs on almost every message. Because it's one block,
the static text can never be served from cache — the dynamic tail always
breaks the byte-for-byte match for the whole block, every time.

## What this does NOT do — read this before touching anything

- **No conditional "if venue is big enough, cache it" logic is being added,
  and none is needed.** Anthropic's API already has an automatic minimum —
  a cache breakpoint silently does nothing if the content before it is under
  a per-model token floor (4096 tokens for the Haiku model this app uses).
  There is no error and no way to under/overshoot it from our side; we just
  structure the prompt so caching _can_ kick in when a venue's static content
  happens to clear that floor, and does nothing differently (same as today)
  when it doesn't. This packet does not write any token-counting or
  size-gating code.
- **This cannot make responses worse.** `cache_control` is a billing/latency
  hint to Anthropic's backend — it has zero effect on what the model sees or
  how it answers. Splitting one system block into two adjacent blocks is
  invisible to the model: the API concatenates all `system` block text into
  one prompt before the model ever sees it, in order, exactly as if it were
  still one block. Two blocks vs. one block is the same prompt to the model.
- **The one behavior-adjacent change is the content reorder itself** — moving
  the "Rules" section to before the retrieved-places list means two rule
  bullets that said "the venue data **above**" needs to say something
  position-independent instead (see Part 1). That's a wording tweak, not a
  removal — every instruction the model receives today is still present,
  worded to not depend on where it sits in the prompt. Everything else is
  unchanged text, just reordered and re-blocked.
- **No existing test's assertions change.** All current tests in
  `venue-context.test.ts` do `.toContain(...)` checks that don't care about
  order — they should pass unmodified. New tests are added, not existing ones
  edited.

## Expected effect (be honest about magnitude)

Caching can only start helping on the **2nd+ message of the same chat
session** (system prompt is rebuilt fresh per message; only re-sending the
_same_ static prefix on a later turn can hit a cache). Whether it activates
at all for a given venue depends on whether that venue's static content
(guide notes + operator guidance + rules text) clears the 4096-token floor —
smaller venues with short guide notes may still not trigger caching, which is
identical to today's behavior, not a regression. Venues with longer
`aiGuideNotes`/`guideNotes` and multi-turn conversations benefit most. This is
a genuine but modest efficiency win, not a correctness fix — treat it as
low-priority, low-risk cleanup.

## Coordination with `engagement-questions.md`

If that packet has already been applied, `venue-context.ts` will have an
`engagementQuestion` param and an `engagementQuestionSection` string. That
section is picked **fresh per turn** (it's often absent, and when present it
names a different question depending on the day's random pick) — it must be
treated the same as the places/knowledge section: **dynamic, not static**.
When applying this packet, if `engagementQuestionSection` already exists,
move it into the dynamic part built in Part 1 below (immediately before the
`MOST RELEVANT PLACES` line), not the static part. If that packet has not
been applied yet, ignore this note — there is nothing to move.

---

## Part 1 — `packages/api/src/lib/venue-context.ts`

Add a new exported function, `buildVenueSystemPromptParts`, that returns the
static and dynamic portions separately. Keep the existing
`buildVenueSystemPrompt` export working exactly as before — it becomes a thin
wrapper that concatenates the two parts, so every existing caller and every
existing test keeps working untouched.

Replace the body of the file from the `buildVenueSystemPrompt` function
definition (the `export function buildVenueSystemPrompt(params: {...}` block)
to the end of the file with:

```ts
export function buildVenueSystemPromptParts(params: {
  venue: VenueInfo
  relevantPlaces: RelevantPlace[]
  knowledgeEntries?: KnowledgeEntry[]
  activeUpdates?: ActiveUpdate[]
  userLat: number
  userLng: number
  featuredPlace?: FeaturedPlace | null
  language?: string | null
  guideMode?: string | null
}): { staticPart: string; dynamicPart: string } {
  const { venue, relevantPlaces, featuredPlace, language } = params
  const knowledgeEntries = params.knowledgeEntries ?? []
  const activeUpdates = params.activeUpdates ?? []
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
            return `[${u.severity}] ${u.title}${redirect}${body}`
          })
          .join('\n')}`

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
- For exploratory questions ("what's good here", "what should I see"), suggest one or two options with a brief reason - no distances unless asked.
- Category guide — treat each place type accordingly:
  • attraction / exhibit: Highlight its character and what makes it worth experiencing.
  • food: Describe the offering briefly; give directions when asked.
  • utility: Be direct and factual — just say where it is. No promotional language.
  • entrance: Mention only when discussing how to get in, out, or reach a specific area.
  • location: This is a navigation landmark, not a destination. Never suggest visiting it. Use it only as a spatial reference in directions (e.g. "near the northwest corner", "just past the fountain area"). If a visitor asks about it directly, explain it as a reference point.`

  // Static: identical for a given venue config across every turn of a session
  // (until an operator edits guide notes/tone/alerts). Placed first so it can
  // be cache_control'd as its own block in chat.ts.
  const staticPart = `You are ${guideName}, ${roleDescription} for ${venue.name}.

About this venue:
${venueDescription}${guideNotesSection}${operatorGuidanceSection}${featuredPlaceSection}${alertsSection}

Rules:
- Ground every answer in the venue and place data provided in this prompt. Do not invent places or distances.
- Active alerts take priority over all other information. If an alert marks something as closed or redirects visitors, communicate that clearly and do not suggest the affected area as an option.
- Ground answers in the knowledge base entries when relevant. Treat them as authoritative venue information.
- Use the place data as background knowledge, not as text to quote. Paraphrase and summarize — never copy descriptions verbatim. Mention only what is relevant to the visitor's question.
${guideModeRules}
- Match answer length to the question. Simple questions (where is, what is) get 1–2 sentences. Process or FAQ questions (what do I do, how does it work) can use up to 4–5 sentences if genuinely needed. Never pad a short answer to fill space.
- Never use markdown, bullet points, asterisks, or headers. Plain conversational text only.
- Never reveal internal data like scores or IDs.
- ${toneInstruction}

${languageRule}`

  // Dynamic: retrieval-based, differs on (almost) every message. Never
  // cache_control this block — there's nothing to reuse turn-to-turn.
  const dynamicPart = `

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
```

Two wording changes from the original, both called out above: the first
Rules bullet no longer says "above" (the place data now comes after, not
before), and the knowledge-base bullet no longer says "above" either. No
instruction was removed — only reworded to not assume a position.

---

## Part 2 — `packages/api/src/routers/chat.ts`

### 2a — Import

Change:

```ts
import { buildVenueSystemPrompt } from '../lib/venue-context'
```

to:

```ts
import { buildVenueSystemPromptParts } from '../lib/venue-context'
```

### 2b — Replace the system-prompt construction and the Anthropic call

Find this block (around line 334):

```ts
// 5. Build context — history arrives newest-first, reverse to oldest-first for Claude
const systemPrompt = buildVenueSystemPrompt({
  venue,
  relevantPlaces,
  knowledgeEntries: relevantKnowledgeEntries,
  activeUpdates,
  userLat: contextLat,
  userLng: contextLng,
  featuredPlace,
  ...(input.language ? { language: input.language } : {}),
  guideMode,
})
const history = historyDesc.reverse()
```

Replace with:

```ts
// 5. Build context — history arrives newest-first, reverse to oldest-first for Claude
const { staticPart, dynamicPart } = buildVenueSystemPromptParts({
  venue,
  relevantPlaces,
  knowledgeEntries: relevantKnowledgeEntries,
  activeUpdates,
  userLat: contextLat,
  userLng: contextLng,
  featuredPlace,
  ...(input.language ? { language: input.language } : {}),
  guideMode,
})
const history = historyDesc.reverse()
```

Then find the Anthropic call just below it:

```ts
      const result = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [
```

Replace the `system` line with two blocks — the static part carries the
cache breakpoint, the dynamic part does not (nothing to reuse turn-to-turn):

```ts
      const result = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: dynamicPart },
        ],
        messages: [
```

No other lines in `chat.ts` change. `staticPart + dynamicPart` is
byte-identical to what `systemPrompt` used to contain — same total content,
sent to the model as one continuous prompt exactly as before (the API
concatenates system blocks together before the model reads them), just split
at a point that lets Anthropic reuse the first block on later turns.

If the `engagement-questions.md` packet has already been applied, chat.ts
will already fetch `tenantEngagement`/`engagementQuestions` and compute
`selectedEngagementQuestion` above this block, and will already spread
`engagementQuestion` into the `buildVenueSystemPromptParts` call. Leave that
part untouched here — just make sure (per the coordination note above) that
`engagementQuestionSection` was placed in `dynamicPart` inside
`venue-context.ts`, not `staticPart`.

---

## Tests

### `packages/api/src/lib/venue-context.test.ts` — add, don't remove

Every existing test stays as-is (they call `buildVenueSystemPrompt`, which
still returns the same concatenated string). Add:

1. **`buildVenueSystemPromptParts` splits correctly** — call it with the same
   fixtures already in the file; assert `staticPart` contains `'City Zoo'`
   and `'Rules:'` but does **not** contain `'Elephant Enclosure'`; assert
   `dynamicPart` contains `'Elephant Enclosure'` and
   `'MOST RELEVANT PLACES FOR THIS QUERY'`.
2. **Concatenation equivalence** — for the same input, assert
   `buildVenueSystemPrompt(input) === buildVenueSystemPromptParts(input).staticPart + buildVenueSystemPromptParts(input).dynamicPart`.
3. **Empty places still works** — reuse the existing "handles empty places
   gracefully" fixture; assert `dynamicPart` still contains
   `'No specific points of interest have been configured yet.'` and
   `staticPart` is unaffected.

### `packages/api/src/routers/chat.test.ts` — extend the existing `send` test setup

Add an assertion on the mocked Anthropic client's `messages.create` call
arguments: `system` is an array of exactly two blocks; the first has
`cache_control: { type: 'ephemeral' }` and the second does not; concatenating
`system[0].text + system[1].text` still contains the venue name and at least
one retrieved place's name (reuse whatever fixtures the existing chat tests
already set up).

---

## Manual verification (do this before calling it done)

This packet reorders text the model reads, so run the automated tests _and_
eyeball real output:

1. `pnpm test` — all existing and new tests green.
2. Start the app (`/run` or your usual dev flow) and open a venue's guest
   chat. Send 3–4 messages in the **same session** (mix of a location
   question, a "what should I see" question, and a follow-up). Confirm
   responses still ground correctly in venue/place data, respect any active
   alerts, and don't regress in tone or length versus what you'd expect from
   the current deployed behavior.
3. Optional, not required for done: temporarily log
   `result.usage.cache_read_input_tokens` / `cache_creation_input_tokens`
   after the `anthropic.messages.create` call in `chat.ts` for a local test
   session, to confirm cache reads appear on the 2nd+ message for a venue
   with enough static content — then remove the temporary log before
   committing.

---

## Definition of Done

- [ ] `buildVenueSystemPromptParts` added to `venue-context.ts`; `buildVenueSystemPrompt` unchanged in behavior (thin wrapper)
- [ ] Two "above"-referencing Rules bullets reworded to be position-independent; no rule content removed
- [ ] `chat.ts` sends `system` as two blocks — static (cache_control ephemeral) then dynamic (no cache_control)
- [ ] All existing tests in `venue-context.test.ts` and `chat.test.ts` pass unmodified
- [ ] New tests added per the Tests section above, all passing
- [ ] Manual multi-turn chat smoke test shows no regression in response grounding, tone, or length
- [ ] `pnpm typecheck` passes with no new errors
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

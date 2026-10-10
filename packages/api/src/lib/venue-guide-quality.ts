/**
 * Guide-quality review of venue package records. The visitor guide talks the way records are
 * written, so research notes, missing kinds and loose height rules in a record become wrong or
 * robotic answers. These checks are deterministic, never block an import, and come back as
 * package warnings that tell the author exactly what to rewrite (operator manual, "Writing guide
 * records").
 */

import { hiddenGuideSentences } from './guest-facing-text'

export type GuideQualityRecord =
  | {
      kind: 'place'
      path: string
      name: string
      type: string
      itemType: string | null
      shortDescription: string | null
      longDescription: string | null
    }
  | { kind: 'knowledge'; path: string; title: string; category: string; content: string }

export type GuideQualityWarning = { code: string; path: string; message: string }

const MANUAL = 'See the operator manual, "Writing guide records".'
// Enough to show an author the pattern without flooding a research-heavy package.
const MAX_HIDDEN_SENTENCE_WARNINGS_PER_FIELD = 3
const MAX_HIDDEN_SENTENCE_WARNINGS_PER_PACKAGE = 100
const QUOTE_CHARS = 150
const LABEL_CHARS = 80
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

// Research bookkeeping, location-pin notes and record-talk that the guide would repeat to visitors.
const RESEARCH_TEXT =
  /\b(?:approximate (?:anchor|location|pin|research)|(?:feature|approach|area|building|canopy) anchor|this pin|test (?:pin|location)|epsg|aerial imagery|community[- ]mapped|researched|research (?:location|date|note)|as checked|checked (?:on )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d|(?:official|ride|attraction|ticket|dining) page (?:lists|says|shows)|(?:listing|page) does not establish|does not establish|not (?:been )?verified|unverified|source caveats?|sources? (?:conflict|disagree)|summary chart|landmark appearance|visitor photo|photo credit|route (?:is )?not certified)\b/iu
const RECORD_TALK =
  /\b(?:this guide|the guide (?:does|has|lists)|(?:is|are) listed (?:as|on|in)|listed (?:on|in) the|published (?:menu|prices?|hours|requirements))\b/iu
const URL = /https?:\/\/\S+/giu
const LINK_TOPIC = /\b(?:tickets?|admission|passes|booking|book|reserv|buy|gift cards?)\b/iu
const RIDE_KIND = /\b(?:ride|coaster|attraction|slide)\b/iu
const HEIGHT_MENTION = /\b\d{2}(?:\.\d)?\s*(?:"|”|in\b|inch(?:es)?\b)/iu
// An initial such as the "F." and "D." in "H.R. Marlow" is part of a name, not a sentence end.
const KIND_SENTENCE =
  /^(?:[^.!?]|(?<=\b\p{Lu})\.){0,160}?\b(?:is|are|was|were|offers|serves|has|have)\b/u
const SENTENCE_END = /(?<=[.!?])(?<!\b\p{Lu}\.)\s+/u

const firstSentence = (text: string | null | undefined) =>
  (text ?? '').trim().split(SENTENCE_END)[0] ?? ''

// A Knowledge record about one thing (an exhibit, vessel, ride, outlet, program or amenity), by its
// category, as opposed to a policy, planning, list or overview topic. Only these must open by kind.
const ENTITY_CATEGORY =
  /\b(?:exhibits?|exhibitions?|galleries|gallery|vessels?|boats?|rides?|attractions?|coasters?|dining|restaurants?|food outlets?|shops?|shopping|programs?|programmes?|animals?|gardens?|facilities|amenities|shows?|experiences?)\b/iu
const NON_ENTITY_TITLE =
  /\b(?:overview|by\b|list|heights|prices|hours|calendar|planning|plan your|map|finding|policy|policies|rules|faq)\b|n['’]t\b/iu
// A sentence that talks about a source instead of the place: an account, report, panel, photo,
// website or catalog as its subject, or a claim that a source does or does not prove something.
const SOURCE_NARRATION =
  /\b(?:(?:do|does|did) not (?:establish|prove)|(?:is|are|was) not (?:proof|evidence)|not (?:proof|evidence) (?:of|that)|(?:was|were) reported\b|reported that|an? (?:\d{4} |historical |dated |undated )?(?:account|report|appeal|panel|photo(?:graph)?|plaque) (?:connects|describes|recalls|shows|showed|dates|names|suggests)|photographed|(?:the|its) (?:website|web page|blog|catalog record) (?:separately )?(?:describes|says|lists|shows|does not)|recovered (?:date )?list|(?:museum|restoration|historical) (?:account|blog) (?:describes|recalls|leaves)|dated display report|(?:the )?sources? (?:do|does) not)\b/iu
// Safety cautions keep their wording even when it sounds like a disclaimer.
const SAFETY_SENTENCE =
  /\b(?:allerg\w*|cross-contact|gluten|peanuts?|tree nuts?|height|restraints?|medical|pregnan\w*|weight limits?)\b/iu
const MAX_SOURCE_NARRATION_PER_RECORD = 3
const OVERVIEW_TITLE = /\boverview\b/iu
const ENTITY_SUFFIX = /\s+(?:indoor |outdoor )?(?:exhibit|display|exhibition)$/iu
const matchText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']s\b/gu, '')
    .replace(/[’']/gu, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
/** The part of a title an overview should name: "Workboats: Models" -> "workboats". */
const overviewName = (title: string) =>
  matchText(
    title
      .split(/\s*(?::| - | – | — |\()\s*/u)[0]!
      .replace(ENTITY_SUFFIX, '')
      .replace(/^the\s+/iu, ''),
  )

const sentencesOfText = (text: string) =>
  text
    .replace(/\r/gu, '')
    .split('\n')
    .flatMap((line) => line.split(SENTENCE_END))
    .map((sentence) => sentence.trim())
    .filter(Boolean)

function textOf(record: GuideQualityRecord): Array<{ field: string; text: string }> {
  return record.kind === 'place'
    ? [
        { field: 'shortDescription', text: record.shortDescription ?? '' },
        { field: 'longDescription', text: record.longDescription ?? '' },
      ]
    : [{ field: 'content', text: record.content }]
}

export function guideQualityWarnings(
  records: readonly GuideQualityRecord[],
): GuideQualityWarning[] {
  const warnings: GuideQualityWarning[] = []
  let hiddenSentenceWarnings = 0
  for (const record of records) {
    const label = record.kind === 'place' ? record.name : record.title
    const fields = textOf(record)

    const research = fields.map((f) => ({ ...f, m: f.text.match(RESEARCH_TEXT) })).find((f) => f.m)
    if (research?.m) {
      warnings.push({
        code: 'GUIDE_QUALITY_RESEARCH_TEXT',
        path: `${record.path}.${research.field}`,
        message: `“${label}” contains research or location-pin notes (“${research.m[0]}”). The guide repeats them to visitors. Keep facts, drop the bookkeeping; sources go in sourceUrl/sourceName. ${MANUAL}`,
      })
    }
    const talk = fields.map((f) => ({ ...f, m: f.text.match(RECORD_TALK) })).find((f) => f.m)
    if (talk?.m) {
      warnings.push({
        code: 'GUIDE_QUALITY_RECORD_VOICE',
        path: `${record.path}.${talk.field}`,
        message: `“${label}” talks about its own information (“${talk.m[0]}”). State the fact directly, as staff would. ${MANUAL}`,
      })
    }
    // Source narration the phrase list misses ("The photographed panel dates…", "these plans do not
    // prove…"): the fact belongs in the record with its date, the source in sourceName/sourceUrl.
    for (const field of fields) {
      const narrated = sentencesOfText(field.text).filter(
        (sentence) =>
          SOURCE_NARRATION.test(sentence) &&
          !SAFETY_SENTENCE.test(sentence) &&
          // Already reported as research text, which names the same fix.
          !RESEARCH_TEXT.test(sentence),
      )
      for (const sentence of narrated.slice(0, MAX_SOURCE_NARRATION_PER_RECORD)) {
        warnings.push({
          code: 'GUIDE_QUALITY_SOURCE_NARRATION',
          path: `${record.path}.${field.field}`,
          message: `“${clip(label, LABEL_CHARS)}” talks about a source instead of the place: “${clip(sentence, QUOTE_CHARS)}”. State the fact itself, with its date when it is dated (“The Marlows began collecting in 1970”), and keep one plain visitor caution only where something is really unknown. Do not drop the fact or a safety caution to silence this. ${MANUAL}`,
        })
      }
    }
    // The exact sentences the visitor guide leaves out, so no fact disappears without notice.
    for (const field of fields) {
      for (const sentence of hiddenGuideSentences(field.text).slice(
        0,
        MAX_HIDDEN_SENTENCE_WARNINGS_PER_FIELD,
      )) {
        if (hiddenSentenceWarnings >= MAX_HIDDEN_SENTENCE_WARNINGS_PER_PACKAGE) break
        hiddenSentenceWarnings += 1
        const quote = clip(sentence, QUOTE_CHARS)
        warnings.push({
          code: 'GUIDE_QUALITY_HIDDEN_SENTENCE',
          path: `${record.path}.${field.field}`,
          message: `“${clip(label, LABEL_CHARS)}”: the full venue guide leaves this sentence out, because it drops whole sentences that read as research notes or source lists: “${quote}”. Any fact in it is lost too. Restate the fact in its own sentence, as staff would say it. ${MANUAL}`,
        })
      }
    }
    const urls = fields.flatMap((f) => f.text.match(URL) ?? [])
    const linkTopic =
      record.kind === 'knowledge' && LINK_TOPIC.test(`${record.title} ${record.category}`)
    if (urls.length > (linkTopic ? 1 : 0)) {
      warnings.push({
        code: 'GUIDE_QUALITY_URL_IN_TEXT',
        path: `${record.path}.${record.kind === 'place' ? 'longDescription' : 'content'}`,
        message: `“${label}” has ${urls.length} web address(es) in its text. Keep only one page a visitor would use (tickets or booking) in a tickets topic; put sources in sourceUrl. ${MANUAL}`,
      })
    }

    if (record.kind === 'place') {
      if (/\((?:[^)]*\b(?:anchor|reference|mapped|pin|test)\b[^)]*)\)/iu.test(record.name)) {
        warnings.push({
          code: 'GUIDE_QUALITY_NAME_LABEL',
          path: `${record.path}.name`,
          message: `Place name “${record.name}” carries a research label. Use the name visitors know. ${MANUAL}`,
        })
      }
      const opening = firstSentence(record.shortDescription || record.longDescription)
      if (opening && !KIND_SENTENCE.test(opening)) {
        warnings.push({
          code: 'GUIDE_QUALITY_FIRST_SENTENCE',
          path: `${record.path}.shortDescription`,
          message: `“${record.name}” should open by saying what it is, by kind and where (“${record.name} is a … in …”, for example “Thunderbolt is a junior roller coaster in the Ember realm.”). The guide sorts and counts by this sentence. ${MANUAL}`,
        })
      }
    } else {
      if (
        ENTITY_CATEGORY.test(record.category) &&
        !NON_ENTITY_TITLE.test(record.title) &&
        !KIND_SENTENCE.test(firstSentence(record.content))
      ) {
        warnings.push({
          code: 'GUIDE_QUALITY_FIRST_SENTENCE',
          path: `${record.path}.content`,
          message: `“${clip(record.title, LABEL_CHARS)}” should open with a full sentence saying what it is (“${clip(record.title, LABEL_CHARS)} is a … in …”, for example “Pond Boats is an indoor exhibit of miniature sailing boats.”), then a detail a visitor can use. A fragment such as “Recreated workshop.” cannot answer a follow-up. ${MANUAL}`,
        })
      }
      if (/\?\s*$|:\s*visitor information$/iu.test(record.title)) {
        warnings.push({
          code: 'GUIDE_QUALITY_TITLE',
          path: `${record.path}.title`,
          message: `Title “${record.title}” should be a plain name (“Parking”, “Thunderbolt”), not a question or research label. ${MANUAL}`,
        })
      }
      if (
        RIDE_KIND.test(`${record.title} ${record.category}`) &&
        HEIGHT_MENTION.test(record.content) &&
        !/^Height:/mu.test(record.content) &&
        // A chart of "Ride: 48 in to ride" lines is already exact.
        (record.content.match(/^[^:\n]{2,80}:\s*\d{1,2}\s*in\b/gmu)?.length ?? 0) < 3
      ) {
        warnings.push({
          code: 'GUIDE_QUALITY_HEIGHT_LINE',
          path: `${record.path}.content`,
          message: `“${record.title}” mentions a height but has no “Height:” line. Write it exactly, one line per ride: “Height: 36 in with an adult; 48 in to ride alone”. ${MANUAL}`,
        })
      }
    }
  }
  return [...warnings, ...overviewCoverageWarnings(records)]
}

/**
 * An overview topic is how the guide answers "what is there" and "how many", so it must name every
 * other record in its category. Checked among the records in this package only.
 */
function overviewCoverageWarnings(records: readonly GuideQualityRecord[]): GuideQualityWarning[] {
  const knowledge = records.filter(
    (record): record is Extract<GuideQualityRecord, { kind: 'knowledge' }> =>
      record.kind === 'knowledge',
  )
  return knowledge.flatMap((overview) => {
    if (!OVERVIEW_TITLE.test(overview.title)) return []
    const text = ` ${matchText(overview.content)} `
    const missing = knowledge
      .filter(
        (member) =>
          member !== overview &&
          member.category === overview.category &&
          !OVERVIEW_TITLE.test(member.title),
      )
      .map((member) => member.title)
      .filter((title) => {
        const name = overviewName(title)
        return name.length > 0 && !text.includes(` ${name} `)
      })
    if (missing.length === 0) return []
    const shown = missing.slice(0, 12).map((title) => `“${clip(title, LABEL_CHARS)}”`)
    return [
      {
        code: 'GUIDE_QUALITY_OVERVIEW_COVERAGE',
        path: `${overview.path}.content`,
        message: `“${clip(overview.title, LABEL_CHARS)}” does not name ${missing.length} other “${clip(overview.category, LABEL_CHARS)}” record(s): ${shown.join(', ')}${missing.length > shown.length ? ', …' : ''}. The guide answers “what is there” from this overview, so name every one with a few words of what it is. ${MANUAL}`,
      },
    ]
  })
}

type PayloadLike =
  | {
      schemaVersion: 1 | 2
      places: ReadonlyArray<Record<string, unknown>>
      knowledgeEntries: ReadonlyArray<Record<string, unknown>>
    }
  | {
      schemaVersion: 3
      places: {
        create: ReadonlyArray<{ value: Record<string, unknown> }>
        update: ReadonlyArray<{ value: Record<string, unknown> }>
      }
      knowledgeEntries: {
        create: ReadonlyArray<{ value: Record<string, unknown> }>
        update: ReadonlyArray<{ value: Record<string, unknown> }>
      }
    }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null)

function placeRecord(path: string, v: Record<string, unknown>): GuideQualityRecord {
  return {
    kind: 'place',
    path,
    name: str(v.name),
    type: str(v.type),
    itemType: strOrNull(v.itemType),
    shortDescription: strOrNull(v.shortDescription),
    longDescription: strOrNull(v.longDescription),
  }
}

function knowledgeRecord(path: string, v: Record<string, unknown>): GuideQualityRecord {
  return {
    kind: 'knowledge',
    path,
    title: str(v.title),
    category: str(v.category),
    content: str(v.content),
  }
}

/** Guide-quality warnings for every place and knowledge record a venue package creates or updates. */
export function venuePackageGuideQualityWarnings(payload: PayloadLike): GuideQualityWarning[] {
  const records: GuideQualityRecord[] =
    payload.schemaVersion === 3
      ? [
          ...payload.places.create.map((o, i) => placeRecord(`places.create.${i}.value`, o.value)),
          ...payload.places.update.map((o, i) => placeRecord(`places.update.${i}.value`, o.value)),
          ...payload.knowledgeEntries.create.map((o, i) =>
            knowledgeRecord(`knowledgeEntries.create.${i}.value`, o.value),
          ),
          ...payload.knowledgeEntries.update.map((o, i) =>
            knowledgeRecord(`knowledgeEntries.update.${i}.value`, o.value),
          ),
        ]
      : [
          ...payload.places.map((p, i) => placeRecord(`places.${i}`, p)),
          ...payload.knowledgeEntries.map((k, i) => knowledgeRecord(`knowledgeEntries.${i}`, k)),
        ]
  return guideQualityWarnings(records)
}

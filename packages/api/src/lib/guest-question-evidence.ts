import {
  GUEST_QUERY_FUNCTION_WORDS,
  guestKnowledgeScope,
  guestKnowledgeSelectShape,
  guestQueryIsFollowup,
  hasCurrentGuestPublicationAuthority,
  normalizeGuestText,
  type GuestKnowledgeReader,
} from './guest-knowledge-retrieval'
import { guestPlaceScope, guestPlaceSelect } from './guest-directory-index-loader'
import { isPastDatedGuestEvent } from './guest-event-dates'
import { guestPlaceIdentityKey } from './guest-place-identity'
import type {
  GuestDirectoryKnowledge,
  GuestDirectoryPlace,
  GuestVenueDirectory,
} from './guest-venue-directory'

/**
 * Question evidence: which whole authorized guide records answer this question.
 *
 * The loaded guide (the venue directory) is already tenant-, venue-, visibility-, publication-
 * and native-release-fenced and stale-suppressed, and it holds every record body. When the guide
 * is too large to send in full, the model sees one-sentence summaries plus a ranked retrieval
 * sample, so a governing condition in a later sentence of an unretrieved record never reaches it.
 * This ranks every loaded record against the whole question in memory (no positional query
 * clipping, cognate-tolerant plain words, multilingual intent groups) and selects whole records
 * so that each distinct part of the question is covered before a second record for an already
 * covered part. It never splices a record and never adds a record from outside the loaded guide.
 */

// Common guest intents across languages. Each group is one question part, matched by exact word
// form (plural tolerant), never by prefix, so "visitors" or "closest" cannot select a topic.
// Written from general venue vocabulary; words that are common English homographs are left out.
const INTENT_GROUPS: readonly (readonly string[])[] = [
  // price and tickets
  'price prices cost costs fee fees fare fares charges pay paid ticket tickets admission ' +
    'dollars precio precios cuesta cuestan cuanto tarifa tarifas boleto boletos prix coute ' +
    'coutent combien tarif tarifs billet billets preis preise kostet kosten gebuhr gebuhren ' +
    'eintrittskarte prezzo prezzi costo biglietto biglietti quanto preco precos custa ' +
    'bilhete bilhetes',
  // inclusion and free entry
  'included include includes inclusive free covered covers complimentary extra additional ' +
    'incluido incluida incluidos incluye gratis gratuito gratuita inclus incluse compris gratuit ' +
    'gratuite inbegriffen enthalten kostenlos incluso inclusa compreso',
  // entry and admission
  'entry entrance enter admission admit entrada entrar entree eintritt ingresso ingreso',
  // photography
  'photo photos photograph photographs photography camera cameras pictures picture selfie ' +
    'selfies flash filming video foto fotos fotografia fotografias fotografiar photographier ' +
    'fotografieren fotografare fotografar kamera',
  // food and drink
  'eat eating food foods dining dine restaurant restaurants cafe cafes meal meals snack snacks ' +
    'lunch dinner breakfast hungry menu sandwich sandwiches drink drinks coffee tea picnic comida ' +
    'comer almuerzo cena bebida bebidas restaurante manger nourriture repas dejeuner boisson ' +
    'boissons essen speisen imbiss mittagessen getranke mangiare cibo pranzo bevande lanche almoco',
  // step-free access
  'wheelchair wheelchairs accessible accessibility stepfree lift lifts elevator elevators ramp ' +
    'ramps stairs steps mobility accesible accesibilidad ascensor rampa escaleras fauteuil ' +
    'roulant ascenseur escalier escaliers rollstuhl barrierefrei aufzug rampe treppe treppen ' +
    'carrozzina ascensore accessibile cadeira rodas elevador acessivel escadas',
  // opening hours and closing
  'hours opening closing open opens closes closed horario horarios abre abierto cierra cerrado ' +
    'horaires ouvert ouvre ferme offnungszeiten geoffnet offnet geschlossen schliesst orari ' +
    'orario aperto chiuso chiude aberto fechado',
  // ages, children and adults
  'age ages aged child children kid kids toddler toddlers baby babies infant infants adult ' +
    'adults teen teens teenager teenagers daughter accompanied accompanying supervision ' +
    'supervised nino ninos nina ninas hijo hija hijos edad anos adulto adultos enfant enfants ' +
    'adulte adultes kinder alter jahre jahrige erwachsene erwachsener bambino bambini bambina ' +
    'anni adulti crianca criancas idade filho filha',
  // height rules
  'height tall taller inches altura taille grosse altezza',
  // booking
  'book booking bookings reservation reservations advance reservar reserva reservas reserver ' +
    'buchen buchung reservieren reservierung prenotare prenotazione',
  // duration
  'minutes minute mins duration lasts minutos duracion dure duree minuten dauer dauert minuti ' +
    'durata duracao',
  // screens and digital displays
  'screen screens screenfree digital pantalla pantallas ecran ecrans bildschirm bildschirme ' +
    'schermo schermi',
  // hands-on activity
  'touch hands interactive tocar interactivo experimentar toucher interactif anfassen beruhren ' +
    'interaktiv ausprobieren toccare interattivo interativo',
  // events, shows and schedules
  'event events shows demonstration demonstrations demo talks tour tours schedule evento ' +
    'eventos espectaculo evenement evenements spectacle veranstaltung vorfuhrung fuhrung ' +
    'spettacolo espetaculo',
  // toilets
  'restroom restrooms bathroom bathrooms toilet toilets bano banos aseo aseos toilettes ' +
    'toiletten bagno bagni banheiro',
  // pets
  'dog dogs pet pets perro perros mascota mascotas chien chiens hund hunde cani cachorro',
  // strollers
  'stroller strollers pushchair pushchairs pram prams buggy buggies cochecito carrito ' +
    'poussette kinderwagen passeggino carrinho',
  // parking
  'parking aparcamiento estacionamiento stationnement parkplatz parcheggio estacionamento',
  // languages and guides
  'language languages audio guided idioma idiomas langue langues sprache sprachen lingua lingue',
].map((group) => group.split(' '))

const STEM_CHARS = 5
const MAX_STEM_CHARS = 7
const BM25_K1 = 1.2
const BM25_B = 0.5
const TITLE_REPEAT = 2
// A part of the question already covered by a selected record still counts, at this weight, so
// list questions ("which exhibits...") keep collecting matching records.
const COVERED_TERM_WEIGHT = 0.4
// A record's own relevance (undiscounted) must reach this share of the most relevant record's to
// be selected at all. Coverage only orders eligible records; it never makes a weak one eligible,
// and it never hides a strong alternative for a part another record already answers.
const MIN_RELATIVE_SCORE = 0.25
// A FULL guide already carries every body, so a topic name is pointed at only when it is close
// to the strongest match: a loose focus list would steer the answer toward unrelated topics.
const FULL_FOCUS_MIN_RELATIVE_SCORE = 0.5
// A plain word found in more than this share of records says nothing about which record answers;
// a question made only of such words ("ok thanks", "what next?") selects nothing.
const INFORMATIVE_MAX_SHARE = 0.35
const INFORMATIVE_MIN_RECORDS = 3
const FOLLOWUP_TERM_WEIGHT = 0.5
const MAX_QUERY_TERMS = 24
// Bounds the greedy selection; more picks than every budget below combined is never useful.
const MAX_RANKED = 40

export const QUESTION_EVIDENCE_MAX_KNOWLEDGE_RECORDS = 10
export const QUESTION_EVIDENCE_MAX_PLACES = 3
/** Whole bodies in the dynamic context (retrieved + linked + question evidence, with places). */
export const QUESTION_EVIDENCE_MAX_CONTEXT_CHARS = 30_000
/** FULL guides already carry every body; only this many relevant topic names are pointed at. */
export const QUESTION_EVIDENCE_MAX_FOCUS_TOPICS = 6

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u

function singular(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token
}

/**
 * Prefix stem for plain words, so inflections and cognates meet ("supplement"/"supplément",
 * "información"/"information"). Longer words keep a longer prefix, so "restrictions" and
 * "restrooms" stay apart.
 */
function stem(token: string): string {
  if (CJK.test(token)) return token
  const base = singular(token)
  if (base.length <= STEM_CHARS) return base
  return base.slice(0, Math.min(MAX_STEM_CHARS, Math.max(STEM_CHARS, base.length - 3)))
}

/** Words, with "step-free" kept whole and unspaced CJK text split into character pairs. */
function tokens(text: string): string[] {
  const normalized = normalizeGuestText(text).replace(/\bstep[\s-]+free\b/gu, 'stepfree')
  return (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((token) => {
    if (!CJK.test(token) || token.length <= 2) return [token]
    return Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))
  })
}

const INTENT_FORMS = INTENT_GROUPS.map(
  (group) => new Set(group.map((word) => singular(normalizeGuestText(word)))),
)

type QueryTerm = {
  key: string
  kind: 'intent' | 'word'
  /** Exact word forms (intent) or prefix stems (plain word) that match this part. */
  forms: ReadonlySet<string>
  weight: number
}

/** The distinct parts of a question: intent groups plus remaining content words, in any order. */
export function guestQuestionTerms(
  query: string,
  previousQuery?: string | null,
  venueName?: string | null,
): QueryTerm[] {
  // The venue's own name never tells its records apart ("Can we buy sandwiches around <venue>?").
  const venueStems = new Set(tokens(venueName ?? '').map(stem))
  const own = questionTerms(query, 1, venueStems)
  if (!previousQuery || !guestQueryIsFollowup(query)) return own
  const keys = new Set(own.map((term) => term.key))
  return [
    ...own,
    ...questionTerms(previousQuery, FOLLOWUP_TERM_WEIGHT, venueStems).filter(
      (term) => !keys.has(term.key),
    ),
  ].slice(0, MAX_QUERY_TERMS)
}

function questionTerms(
  query: string,
  weight: number,
  venueStems: ReadonlySet<string>,
): QueryTerm[] {
  const terms = new Map<string, QueryTerm>()
  for (const token of tokens(query)) {
    if (GUEST_QUERY_FUNCTION_WORDS.has(token)) continue
    // Bare numbers ("kids are 5 and 11") match every duration and price; intent words carry them.
    if (/^\p{N}+$/u.test(token)) continue
    if (token.length < 3 && !CJK.test(token)) continue
    const groupIndex = INTENT_FORMS.findIndex((group) => group.has(singular(token)))
    if (groupIndex >= 0) {
      const key = `intent:${groupIndex}`
      if (!terms.has(key))
        terms.set(key, { key, kind: 'intent', forms: INTENT_FORMS[groupIndex]!, weight })
      continue
    }
    const tokenStem = stem(token)
    if (venueStems.has(tokenStem)) continue
    const key = `word:${tokenStem}`
    if (!terms.has(key)) terms.set(key, { key, kind: 'word', forms: new Set([tokenStem]), weight })
  }
  return [...terms.values()].slice(0, MAX_QUERY_TERMS)
}

export type GuestEvidenceCandidate =
  | { kind: 'knowledge'; id: string; record: GuestDirectoryKnowledge; chars: number }
  | { kind: 'place'; id: string; record: GuestDirectoryPlace; chars: number }

function candidateText(candidate: GuestEvidenceCandidate): { title: string; body: string } {
  if (candidate.kind === 'knowledge')
    return {
      title: candidate.record.title,
      body: `${candidate.record.category} ${candidate.record.content}`,
    }
  const place = candidate.record
  return {
    title: place.name,
    body: [
      place.type,
      place.itemType,
      place.areaName,
      place.shortDescription,
      place.longDescription,
      place.hours,
      ...(place.tags ?? []),
    ]
      .filter(Boolean)
      .join(' '),
  }
}

type RecordTerms = {
  length: number
  /** Exact singular word forms, for intent groups. */
  words: Map<string, number>
  /** Prefix stems, for plain words. */
  stems: Map<string, number>
}

function recordTerms(candidate: GuestEvidenceCandidate): RecordTerms {
  const { title, body } = candidateText(candidate)
  const all = [...Array.from({ length: TITLE_REPEAT }, () => tokens(title)).flat(), ...tokens(body)]
  const words = new Map<string, number>()
  const stems = new Map<string, number>()
  for (const token of all) {
    const word = singular(token)
    words.set(word, (words.get(word) ?? 0) + 1)
    const value = stem(token)
    stems.set(value, (stems.get(value) ?? 0) + 1)
  }
  return { length: all.length, words, stems }
}

type Posting = { ordinals: Uint32Array; frequencies: Uint32Array }
type SearchIndex = {
  lengths: number[]
  averageLength: number
  words: Map<string, Posting>
  stems: Map<string, Posting>
  bytes: number
}
const searchIndexes = new Map<string, SearchIndex>()
let searchIndexBytes = 0
let lastBuildBytes = 0
let indexBuilds = 0
let indexHits = 0
const MAX_SEARCH_INDEX_BYTES = 128 * 1024 * 1024
const MAX_VENUE_SEARCH_INDEX_BYTES = 32 * 1024 * 1024

/** Build postings once per authorized content version. Unversioned callers always rebuild safely. */
function questionSearchIndex(candidates: GuestEvidenceCandidate[], version?: string): SearchIndex {
  // IDs discriminate projection, dated-event filtering, ambiguity and stale suppression. Bodies
  // are not hashed or tokenized again on a warm turn with the same scoped version.
  const key = version
    ? JSON.stringify([version, candidates.map((row) => [row.kind, row.id])])
    : null
  const hit = key ? searchIndexes.get(key) : undefined
  if (hit && key) {
    indexHits++
    searchIndexes.delete(key)
    searchIndexes.set(key, hit)
    return hit
  }
  const index: SearchIndex = {
    lengths: [],
    averageLength: 1,
    words: new Map(),
    stems: new Map(),
    bytes: key ? key.length * 2 : 0,
  }
  indexBuilds++
  const words = new Map<string, Array<[number, number]>>()
  const stems = new Map<string, Array<[number, number]>>()
  for (const [ordinal, candidate] of candidates.entries()) {
    const terms = recordTerms(candidate)
    index.lengths.push(terms.length)
    index.bytes += 8
    for (const [source, target] of [
      [terms.words, words],
      [terms.stems, stems],
    ] as const) {
      for (const [word, count] of source) {
        let posting = target.get(word)
        if (!posting) {
          posting = []
          target.set(word, posting)
          index.bytes += word.length * 2 + 80
        }
        posting.push([ordinal, count])
        index.bytes += 8
      }
    }
  }
  for (const [source, target] of [
    [words, index.words],
    [stems, index.stems],
  ] as const) {
    for (const [term, values] of source)
      target.set(term, {
        ordinals: Uint32Array.from(values.map(([ordinal]) => ordinal)),
        frequencies: Uint32Array.from(values.map(([, frequency]) => frequency)),
      })
  }
  lastBuildBytes = index.bytes
  index.averageLength =
    index.lengths.reduce((sum, length) => sum + length, 0) / candidates.length || 1
  if (key && index.bytes <= MAX_VENUE_SEARCH_INDEX_BYTES) {
    searchIndexes.set(key, index)
    searchIndexBytes += index.bytes
    while (searchIndexBytes > MAX_SEARCH_INDEX_BYTES || searchIndexes.size > 32) {
      const oldest = searchIndexes.keys().next().value!
      searchIndexBytes -= searchIndexes.get(oldest)!.bytes
      searchIndexes.delete(oldest)
    }
  }
  return index
}

/** Diagnostics describe retained estimated payload, not JavaScript heap/RSS or database latency. */
export function guestQuestionSearchIndexStats() {
  return {
    entries: searchIndexes.size,
    estimatedBytes: searchIndexBytes,
    lastBuildBytes,
    builds: indexBuilds,
    hits: indexHits,
  }
}

export type GuestQuestionEvidenceRank = {
  kind: 'knowledge' | 'place'
  id: string
  /** The record's own relevance to the whole question, before any coverage discount. */
  score: number
  /** Question part keys this record matches. */
  terms: string[]
}

/**
 * Ranks every candidate record and picks a covering set: each step takes the record adding the
 * most not-yet-covered question weight (covered parts still count at a reduced weight).
 */
export function rankGuestQuestionEvidence(params: {
  query: string
  previousQuery?: string | null
  venueName?: string | null
  candidates: GuestEvidenceCandidate[]
  searchVersion?: string
}): { terms: string[]; ranked: GuestQuestionEvidenceRank[] } {
  const terms = guestQuestionTerms(params.query, params.previousQuery, params.venueName)
  if (terms.length === 0 || params.candidates.length === 0)
    return { terms: terms.map((term) => term.key), ranked: [] }
  const index = questionSearchIndex(params.candidates, params.searchVersion)
  const frequencies = new Map<number, number[]>()
  const documentFrequency = terms.map((term, termIndex) => {
    const matching = new Set<number>()
    const postings = term.kind === 'intent' ? index.words : index.stems
    for (const form of term.forms) {
      const posting = postings.get(form)
      if (!posting) continue
      for (let postingIndex = 0; postingIndex < posting.ordinals.length; postingIndex++) {
        const ordinal = posting.ordinals[postingIndex]!
        const tf = posting.frequencies[postingIndex]!
        let row = frequencies.get(ordinal)
        if (!row) {
          row = Array<number>(terms.length).fill(0)
          frequencies.set(ordinal, row)
        }
        row[termIndex] = row[termIndex]! + tf
        matching.add(ordinal)
      }
    }
    return matching.size
  })
  // Ordinal order keeps exact ties identical to the previous all-document ranker.
  const matchingOrdinals = [...frequencies.keys()].sort((a, b) => a - b)
  const docs = matchingOrdinals.map((ordinal) => ({
    candidate: params.candidates[ordinal]!,
    length: index.lengths[ordinal]!,
    frequencies: frequencies.get(ordinal)!,
  }))
  const averageLength = index.averageLength
  const idf = documentFrequency.map((df) =>
    Math.log(1 + (params.candidates.length - df + 0.5) / (df + 0.5)),
  )
  const informativeLimit = Math.max(
    INFORMATIVE_MIN_RECORDS,
    params.candidates.length * INFORMATIVE_MAX_SHARE,
  )
  // Intent groups are curated question parts; a plain word must be rare among this venue's records.
  const informative = terms.map(
    (term, index) =>
      term.kind === 'intent' ||
      (documentFrequency[index]! > 0 && documentFrequency[index]! <= informativeLimit),
  )
  const contributions = docs.map((doc) =>
    terms.map((term, index) => {
      const tf = doc.frequencies[index]!
      if (tf === 0) return 0
      const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / averageLength)
      return term.weight * idf[index]! * ((tf * (BM25_K1 + 1)) / norm)
    }),
  )
  const relevance = contributions.map((values) => values.reduce((sum, value) => sum + value, 0))
  const floor = Math.max(0, ...relevance) * MIN_RELATIVE_SCORE
  const covered = new Set<number>()
  const remaining = new Set(
    docs.flatMap((_, index) =>
      relevance[index]! > 0 &&
      relevance[index]! >= floor &&
      contributions[index]!.some((value, termIndex) => value > 0 && informative[termIndex])
        ? [index]
        : [],
    ),
  )
  const ranked: GuestQuestionEvidenceRank[] = []
  while (remaining.size > 0 && ranked.length < MAX_RANKED) {
    let best = -1
    let bestGain = 0
    for (const index of remaining) {
      const gain = contributions[index]!.reduce(
        (sum, value, termIndex) => sum + value * (covered.has(termIndex) ? COVERED_TERM_WEIGHT : 1),
        0,
      )
      if (gain > bestGain) {
        bestGain = gain
        best = index
      }
    }
    if (best < 0) break
    remaining.delete(best)
    const matched = contributions[best]!.flatMap((value, termIndex) =>
      value > 0 ? [termIndex] : [],
    )
    for (const termIndex of matched) covered.add(termIndex)
    const { candidate } = docs[best]!
    ranked.push({
      kind: candidate.kind,
      id: candidate.id,
      score: Math.round(relevance[best]! * 1000) / 1000,
      terms: matched.map((termIndex) => terms[termIndex]!.key),
    })
  }
  return { terms: terms.map((term) => term.key), ranked }
}

/** Question parts that none of these whole-record texts matches. */
export function uncoveredGuestQuestionTerms(params: {
  query: string
  previousQuery?: string | null
  venueName?: string | null
  texts: ReadonlyArray<string>
}): string[] {
  const all = params.texts.flatMap((text) => tokens(text))
  const words = new Set(all.map(singular))
  const stems = new Set(all.map(stem))
  return guestQuestionTerms(params.query, params.previousQuery, params.venueName)
    .filter(
      (term) =>
        ![...term.forms].some((value) => (term.kind === 'intent' ? words : stems).has(value)),
    )
    .map((term) => term.key)
}

export type GuestQuestionEvidenceTrace = {
  mode: 'FULL' | 'DIRECTORY' | 'NONE'
  terms: string[]
  /** Question parts no whole record in context matches (a summary line may still mention them). */
  uncoveredTerms: string[]
  addedKnowledgeIds: string[]
  addedPlaceIds: string[]
  /** Ranked records that would have joined but did not fit the whole-record budget. */
  budgetExcludedIds: string[]
}

const placeChars = (place: GuestDirectoryPlace) =>
  (place.shortDescription?.length ?? 0) + (place.longDescription?.length ?? 0)

/**
 * Whole guide records to add for this question. In DIRECTORY mode the bodies join the dynamic
 * context; in FULL mode every body is already present, so only relevant topic names are added
 * (the prompt renders guide records by name). Records already in context are never repeated.
 */
export function selectGuestQuestionEvidence<K extends { id?: string; content: string }>(params: {
  query: string
  previousQuery?: string | null
  venueName?: string | null
  directory: GuestVenueDirectory
  mode: 'FULL' | 'DIRECTORY' | 'NONE'
  currentDate: string
  knowledgeInContext: ReadonlyArray<K>
  placesInContext: ReadonlyArray<GuestDirectoryPlace>
  /** Only this many leading context places reach the prompt, so only they use the body budget. */
  placesInContextLimit?: number
  /** At most this many places may be added (the caller's free place slots). */
  maxPlaces?: number
  /** False for recommendation or nearby questions, whose place list has its own ranking. */
  allowPlaces?: boolean
  maxContextChars?: number
}): {
  knowledge: GuestDirectoryKnowledge[]
  places: GuestDirectoryPlace[]
  trace: GuestQuestionEvidenceTrace
} {
  if (params.mode === 'NONE')
    return {
      knowledge: [],
      places: [],
      trace: {
        mode: params.mode,
        terms: [],
        uncoveredTerms: [],
        addedKnowledgeIds: [],
        addedPlaceIds: [],
        budgetExcludedIds: [],
      },
    }
  const presentKnowledge = new Set(
    params.knowledgeInContext.flatMap((entry) => (entry.id ? [entry.id] : [])),
  )
  const presentPlaces = new Set(params.placesInContext.map((place) => place.id))
  const knowledgeCandidates: GuestEvidenceCandidate[] = params.directory.knowledge
    .filter((entry) => !isPastDatedGuestEvent(entry, params.currentDate))
    .map((entry) => ({
      kind: 'knowledge',
      id: entry.id,
      record: entry,
      chars: entry.content.length,
    }))
  // Same-name places stay name-only until identity resolution picks one; never hydrate them here.
  const nameCounts = new Map<string, number>()
  for (const place of params.directory.places) {
    const key = guestPlaceIdentityKey(place.name)
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  const placeCandidates: GuestEvidenceCandidate[] = params.directory.places
    .filter((place) => (nameCounts.get(guestPlaceIdentityKey(place.name)) ?? 0) === 1)
    .map((place) => ({ kind: 'place', id: place.id, record: place, chars: placeChars(place) }))
  const { terms, ranked } = rankGuestQuestionEvidence({
    query: params.query,
    previousQuery: params.previousQuery ?? null,
    venueName: params.venueName ?? null,
    candidates: [...knowledgeCandidates, ...placeCandidates],
    ...(params.directory.searchVersion ? { searchVersion: params.directory.searchVersion } : {}),
  })
  const knowledgeById = new Map(params.directory.knowledge.map((entry) => [entry.id, entry]))
  const placeById = new Map(params.directory.places.map((place) => [place.id, place]))
  const knowledge: GuestDirectoryKnowledge[] = []
  const places: GuestDirectoryPlace[] = []
  const budgetExcludedIds: string[] = []
  const maxChars = params.maxContextChars ?? QUESTION_EVIDENCE_MAX_CONTEXT_CHARS
  let contextChars =
    params.knowledgeInContext.reduce((sum, entry) => sum + entry.content.length, 0) +
    params.placesInContext
      .slice(0, params.placesInContextLimit ?? params.placesInContext.length)
      .reduce((sum, place) => sum + placeChars(place), 0)
  const focusFloor =
    Math.max(0, ...ranked.map((rank) => rank.score)) * FULL_FOCUS_MIN_RELATIVE_SCORE
  for (const rank of ranked) {
    if (rank.kind === 'knowledge') {
      if (presentKnowledge.has(rank.id)) continue
      const entry = knowledgeById.get(rank.id)!
      // FULL guides already carry the body; only the name is rendered, so no body budget applies.
      if (params.mode === 'FULL') {
        if (rank.score >= focusFloor && knowledge.length < QUESTION_EVIDENCE_MAX_FOCUS_TOPICS)
          knowledge.push(entry)
        continue
      }
      if (knowledge.length >= QUESTION_EVIDENCE_MAX_KNOWLEDGE_RECORDS) continue
      if (contextChars + entry.content.length > maxChars) {
        budgetExcludedIds.push(rank.id)
        continue
      }
      contextChars += entry.content.length
      knowledge.push(entry)
    } else {
      // A FULL guide carries every place body already.
      if (params.mode !== 'DIRECTORY' || params.allowPlaces === false) continue
      const placeLimit = Math.min(QUESTION_EVIDENCE_MAX_PLACES, params.maxPlaces ?? Infinity)
      if (presentPlaces.has(rank.id) || places.length >= placeLimit) continue
      const place = placeById.get(rank.id)!
      if (contextChars + placeChars(place) > maxChars) {
        budgetExcludedIds.push(rank.id)
        continue
      }
      contextChars += placeChars(place)
      places.push(place)
    }
  }
  return {
    knowledge,
    places,
    trace: {
      mode: params.mode,
      terms,
      uncoveredTerms: uncoveredGuestQuestionTerms({
        query: params.query,
        previousQuery: params.previousQuery ?? null,
        venueName: params.venueName ?? null,
        texts: [
          ...params.knowledgeInContext.map((entry) => entry.content),
          ...knowledge.map((entry) => `${entry.title} ${entry.content}`),
          ...[...params.placesInContext, ...places]
            .map((place) => candidateText({ kind: 'place', id: place.id, record: place, chars: 0 }))
            .map(({ title, body }) => `${title} ${body}`),
          ...(params.mode === 'FULL'
            ? params.directory.knowledge.map((entry) => `${entry.title} ${entry.content}`)
            : []),
        ],
      }),
      addedKnowledgeIds: knowledge.map((entry) => entry.id),
      addedPlaceIds: places.map((place) => place.id),
      budgetExcludedIds,
    },
  }
}

const MAX_NAMED_QUESTION_PLACES = 6
const MAX_NAMED_PLACE_KNOWLEDGE = 2
const MAX_NAMED_TITLE_KNOWLEDGE = 4

/**
 * Records the visitor names exactly. A place whose full name appears in the question joins as a
 * whole record, with up to two knowledge records whose titles carry that name ("<name> visitor
 * details"). Search cannot be trusted to find these: a numbered or repeated name ("Hall 214",
 * "Alder Hide 00989") shares every word with its neighbours. Longer names claim their words
 * first, so "Harvest Wheel Junior" does not also name "Harvest Wheel". Same-name places are left
 * to identity resolution. Bodies still pass the caller's live revalidation and budget.
 */
export function guestQuestionNamedRecords(params: {
  query: string
  directory: GuestVenueDirectory
  currentDate: string
}): { places: GuestDirectoryPlace[]; knowledge: GuestDirectoryKnowledge[] } {
  let remaining = ` ${guestPlaceIdentityKey(params.query)} `
  const byKey = new Map<string, GuestDirectoryPlace[]>()
  for (const place of params.directory.places) {
    const key = guestPlaceIdentityKey(place.name)
    if (key.length < 3 || !remaining.includes(` ${key} `)) continue
    byKey.set(key, [...(byKey.get(key) ?? []), place])
  }
  const places: GuestDirectoryPlace[] = []
  for (const [key, matches] of [...byKey.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (!remaining.includes(` ${key} `)) continue
    remaining = remaining.split(` ${key} `).join('  ')
    if (matches.length === 1 && places.length < MAX_NAMED_QUESTION_PLACES) places.push(matches[0]!)
  }
  const knowledge: GuestDirectoryKnowledge[] = []
  for (const place of places) {
    const key = guestPlaceIdentityKey(place.name)
    knowledge.push(
      ...params.directory.knowledge
        .filter(
          (entry) =>
            !isPastDatedGuestEvent(entry, params.currentDate) &&
            ` ${guestPlaceIdentityKey(entry.title)} `.includes(` ${key} `),
        )
        .slice(0, MAX_NAMED_PLACE_KNOWLEDGE),
    )
  }
  // A knowledge record is named when its title shares a long exact phrase with the question:
  // three words, or two when one is a number ("Gallery 214"). The longest shared phrases win.
  const questionWords = guestPlaceIdentityKey(params.query).split(' ').filter(Boolean)
  const titled = params.directory.knowledge
    .filter((entry) => !isPastDatedGuestEvent(entry, params.currentDate))
    .flatMap((entry) => {
      const run = longestSharedRun(questionWords, guestPlaceIdentityKey(entry.title).split(' '))
      const named = run.length >= 3 || (run.length === 2 && run.some((word) => /\p{N}/u.test(word)))
      return named ? [{ entry, length: run.length }] : []
    })
  const longest = Math.max(0, ...titled.map(({ length }) => length))
  knowledge.push(
    ...titled
      .filter(({ length }) => length === longest)
      .slice(0, MAX_NAMED_TITLE_KNOWLEDGE)
      .map(({ entry }) => entry),
  )
  return { places, knowledge: [...new Map(knowledge.map((entry) => [entry.id, entry])).values()] }
}

function longestSharedRun(a: string[], b: string[]): string[] {
  let best: string[] = []
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      let k = 0
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++
      if (k > best.length) best = a.slice(i, i + k)
    }
  return best
}

/**
 * The guide behind question evidence is cached for up to a minute. Before a hydrated body reaches
 * the model, re-read those rows through the same live guest scope the directory loader uses
 * (publication authority and adopted-legacy exclusion included): a record unpublished, hidden,
 * adopted or withdrawn since the load is dropped, an edited record is sent in its current form,
 * and an edit that dates it into the past drops it.
 */
export async function revalidateGuestQuestionEvidence(params: {
  reader: unknown
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  asOf: Date
  currentDate: string
  knowledge: GuestDirectoryKnowledge[]
}): Promise<GuestDirectoryKnowledge[]> {
  if (params.knowledge.length === 0) return []
  const reader = params.reader as GuestKnowledgeReader
  const ids = params.knowledge.map((entry) => entry.id)
  const [rows, activated] = await Promise.all([
    reader.venueKnowledgeEntry.findMany({
      where: { ...guestKnowledgeScope(params), id: { in: ids } },
      select: guestKnowledgeSelectShape(),
      take: ids.length,
    }),
    reader.legacyKnowledgeAdoptionActivation
      ? reader.legacyKnowledgeAdoptionActivation.findMany({
          where: { tenantId: params.tenantId, venueId: params.venueId },
          select: { adoption: { select: { legacyKnowledgeEntryId: true } } },
        })
      : Promise.resolve([]),
  ])
  const adopted = new Set(activated.map((row) => row.adoption.legacyKnowledgeEntryId))
  const current = new Map(
    rows
      .filter((row) => hasCurrentGuestPublicationAuthority(row) && !adopted.has(row.id))
      .map((row) => [row.id, row]),
  )
  return params.knowledge.flatMap((entry) => {
    const row = current.get(entry.id)
    if (!row) return []
    const refreshed = {
      ...entry,
      title: row.title,
      category: row.category,
      content: row.content,
      sourceType: row.sourceType,
      sourceName: row.sourceName,
      sourceUrl: row.sourceUrl,
      updatedAt: row.updatedAt,
    }
    return isPastDatedGuestEvent(refreshed, params.currentDate) ? [] : [refreshed]
  })
}

/** Live whole place bodies retain the same tenant, venue, visibility and activity fences. */
export async function revalidateGuestQuestionPlaces(params: {
  reader: unknown
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  places: GuestDirectoryPlace[]
}): Promise<GuestDirectoryPlace[]> {
  if (!params.places.length) return []
  const reader = params.reader as {
    place: { findMany(args: Record<string, unknown>): Promise<GuestDirectoryPlace[]> }
  }
  const ids = params.places.map((place) => place.id)
  const rows = await reader.place.findMany({
    where: { ...guestPlaceScope(params), id: { in: ids } },
    select: guestPlaceSelect,
    take: ids.length,
  })
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    return row ? [row] : []
  })
}

/**
 * Joins question-evidence places to the retrieved place list without displacing it: a pinned
 * entry place stays first, at least `retrievedSlots` retrieved places keep their order, and added
 * places only take slots still free inside `limit`. Already present places are never repeated.
 */
export function mergeGuestQuestionEvidencePlaces<P extends { id: string }>(params: {
  places: P[]
  added: P[]
  pinnedId?: string | null
  limit: number
  retrievedSlots: number
}): P[] {
  const pinned = params.places.filter((place) => place.id === params.pinnedId)
  const retrieved = params.places.filter((place) => place.id !== params.pinnedId)
  const present = new Set(params.places.map((place) => place.id))
  const free = Math.max(
    0,
    params.limit - pinned.length - Math.min(retrieved.length, params.retrievedSlots),
  )
  const added = params.added.filter((place) => !present.has(place.id)).slice(0, free)
  const kept = Math.max(0, params.limit - pinned.length - added.length)
  return [...pinned, ...retrieved.slice(0, kept), ...added, ...retrieved.slice(kept)]
}

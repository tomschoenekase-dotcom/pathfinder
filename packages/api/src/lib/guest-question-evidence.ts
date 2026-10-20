import {
  GUEST_QUERY_FUNCTION_WORDS,
  guestQueryIsFollowup,
  normalizeGuestText,
} from './guest-knowledge-retrieval'
import { isPastDatedGuestEvent } from './guest-event-dates'
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
 * clipping, cognate-tolerant, multilingual intent aliases) and selects whole records so that each
 * distinct part of the question is covered before a second record for an already-covered part.
 * It never splices a record and never adds a record from outside the loaded guide.
 */

// Common guest intents across languages. Each group is one question part: a match on any member
// stem covers that part. Written from general venue vocabulary, not from particular questions.
const INTENT_GROUPS: readonly (readonly string[])[] = [
  // price and tickets
  [
    'price', 'prices', 'cost', 'costs', 'fee', 'fees', 'fare', 'fares', 'charge', 'charges', 'pay',
    'paid', 'ticket', 'tickets', 'admission', 'supplement', 'surcharge', 'dollars', 'precio',
    'precios', 'cuesta', 'cuestan', 'cuanto', 'tarifa', 'tarifas', 'boleto', 'boletos', 'prix',
    'coute', 'coutent', 'combien', 'tarif', 'billet', 'billets', 'preis', 'preise', 'kostet',
    'kosten', 'gebuhr', 'eintrittskarte', 'prezzo', 'prezzi', 'costo', 'costa', 'biglietto',
    'biglietti', 'preco', 'precos', 'custa', 'bilhete', 'bilhetes',
  ],
  // inclusion and free entry
  [
    'included', 'include', 'includes', 'inclusive', 'free', 'covered', 'covers', 'cover',
    'complimentary', 'extra', 'additional', 'incluido', 'incluida', 'incluye', 'gratis', 'gratuito',
    'gratuita', 'inclus', 'incluse', 'compris', 'gratuit', 'gratuite', 'inbegriffen', 'enthalten',
    'kostenlos', 'incluso', 'inclusa', 'compreso', 'incluidos',
  ],
  // entry and admission
  [
    'entry', 'entrance', 'enter', 'admission', 'admit', 'entrada', 'entree', 'eintritt', 'ingresso',
    'ingreso', 'acceder',
  ],
  // photography
  [
    'photo', 'photos', 'photograph', 'photographs', 'photography', 'camera', 'cameras', 'pictures',
    'picture', 'selfie', 'flash', 'filming', 'video', 'foto', 'fotos', 'fotografia', 'fotografias',
    'fotografiar', 'photographier', 'fotografieren', 'fotografare', 'fotografar', 'kamera',
  ],
  // food and drink
  [
    'eat', 'eating', 'food', 'foods', 'dining', 'dine', 'restaurant', 'restaurants', 'cafe', 'cafes',
    'meal', 'meals', 'snack', 'snacks', 'lunch', 'dinner', 'breakfast', 'hungry', 'menu', 'kiosk',
    'sandwich', 'sandwiches', 'drink', 'drinks', 'coffee', 'tea', 'picnic', 'comida', 'comer',
    'bocadillo', 'bocadillos', 'almuerzo', 'cena', 'bebida', 'bebidas', 'restaurante', 'manger',
    'nourriture', 'repas', 'dejeuner', 'boisson', 'boissons', 'essen', 'speisen', 'imbiss',
    'mittagessen', 'getranke', 'mangiare', 'cibo', 'pranzo', 'panino', 'panini', 'bevande',
    'lanche', 'almoco', 'bebida',
  ],
  // step-free access
  [
    'wheelchair', 'wheelchairs', 'accessible', 'accessibility', 'access', 'stepfree', 'lift',
    'lifts', 'elevator', 'elevators', 'ramp', 'ramps', 'stairs', 'steps', 'mobility', 'scooter',
    'silla', 'ruedas', 'accesible', 'accesibilidad', 'ascensor', 'rampa', 'escaleras', 'fauteuil',
    'roulant', 'ascenseur', 'escalier', 'escaliers', 'rollstuhl', 'barrierefrei', 'aufzug',
    'rampe', 'treppe', 'treppen', 'carrozzina', 'sedia', 'rotelle', 'ascensore', 'accessibile',
    'scale', 'cadeira', 'rodas', 'elevador', 'acessivel', 'escadas',
  ],
  // opening hours and closing
  [
    'hours', 'opening', 'closing', 'open', 'opens', 'close', 'closes', 'closed', 'horario',
    'horarios', 'abre', 'abierto', 'cierra', 'cerrado', 'horaires', 'ouvert', 'ouvre', 'ferme',
    'offnungszeiten', 'geoffnet', 'offnet', 'geschlossen', 'schliesst', 'orari', 'orario', 'aperto',
    'chiuso', 'chiude', 'aberto', 'fechado', 'fecha',
  ],
  // ages, children and adults
  [
    'age', 'ages', 'aged', 'old', 'year', 'years', 'child', 'children', 'kid', 'kids', 'toddler',
    'toddlers', 'baby', 'babies', 'infant', 'infants', 'adult', 'adults', 'teen', 'teens',
    'teenager', 'son', 'daughter', 'accompanied', 'accompanying', 'supervision', 'nino', 'ninos',
    'nina', 'ninas', 'hijo', 'hija', 'hijos', 'edad', 'anos', 'adulto', 'adultos', 'enfant',
    'enfants', 'ans', 'adulte', 'adultes', 'kind', 'kinder', 'alter', 'jahre', 'jahrige',
    'erwachsene', 'erwachsener', 'bambino', 'bambini', 'bambina', 'eta', 'anni', 'adulto', 'adulti',
    'crianca', 'criancas', 'idade', 'filho', 'filha',
  ],
  // height rules
  ['height', 'tall', 'taller', 'cm', 'inches', 'altura', 'taille', 'grosse', 'altezza'],
  // booking
  [
    'book', 'booking', 'bookings', 'reserve', 'reservation', 'reservations', 'advance', 'reservar',
    'reserva', 'reservas', 'reserver', 'buchen', 'buchung', 'reservieren', 'reservierung',
    'prenotare', 'prenotazione',
  ],
  // duration
  [
    'minutes', 'minute', 'mins', 'duration', 'lasts', 'minutos', 'duracion', 'dure', 'duree',
    'minuten', 'dauer', 'dauert', 'minuti', 'durata', 'dura', 'duracao',
  ],
  // hands-on activity
  [
    'touch', 'hands', 'interactive', 'tocar', 'interactivo', 'experimentar', 'toucher', 'interactif',
    'anfassen', 'beruhren', 'interaktiv', 'ausprobieren', 'toccare', 'interattivo', 'interativo',
  ],
  // events, shows and schedules
  [
    'event', 'events', 'show', 'shows', 'demonstration', 'demo', 'talk', 'tour', 'tours', 'schedule',
    'evento', 'eventos', 'espectaculo', 'visita', 'evenement', 'spectacle', 'veranstaltung',
    'vorfuhrung', 'fuhrung', 'spettacolo', 'espetaculo',
  ],
  // toilets
  ['restroom', 'restrooms', 'bathroom', 'bathrooms', 'toilet', 'toilets', 'wc', 'bano', 'banos', 'aseo', 'toilettes', 'toiletten', 'bagno', 'bagni', 'banheiro'],
  // pets
  ['dog', 'dogs', 'pet', 'pets', 'perro', 'perros', 'mascota', 'chien', 'chiens', 'hund', 'hunde', 'cane', 'cani', 'cachorro'],
  // strollers
  ['stroller', 'strollers', 'pushchair', 'pram', 'buggy', 'cochecito', 'carrito', 'poussette', 'kinderwagen', 'passeggino', 'carrinho'],
  // parking
  ['parking', 'aparcamiento', 'estacionamiento', 'stationnement', 'parkplatz', 'parcheggio', 'estacionamento'],
  // languages and guides
  ['language', 'languages', 'audio', 'guide', 'guided', 'idioma', 'idiomas', 'langue', 'langues', 'sprache', 'sprachen', 'lingua', 'lingue'],
]

const STEM_CHARS = 5
const BM25_K1 = 1.2
const BM25_B = 0.5
const TITLE_REPEAT = 2
// A part of the question already covered by a selected record still counts, at this weight, so
// list questions ("which exhibits...") keep collecting matching records.
const COVERED_TERM_WEIGHT = 0.4
// A record must reach this share of the strongest record's score to be selected at all.
const MIN_RELATIVE_SCORE = 0.25
const FOLLOWUP_TERM_WEIGHT = 0.5
const MAX_QUERY_TERMS = 24

export const QUESTION_EVIDENCE_MAX_KNOWLEDGE_RECORDS = 10
export const QUESTION_EVIDENCE_MAX_PLACES = 6
/** Whole knowledge bodies in the dynamic context (retrieved + linked + question evidence). */
export const QUESTION_EVIDENCE_MAX_CONTEXT_CHARS = 30_000
/** FULL guides already carry every body; only this many relevant topic names are pointed at. */
export const QUESTION_EVIDENCE_MAX_FOCUS_TOPICS = 6

function stem(token: string): string {
  if (/^\p{N}+$/u.test(token)) return token
  const singular = token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token
  return singular.length > STEM_CHARS ? singular.slice(0, STEM_CHARS) : singular
}

function tokens(text: string): string[] {
  return normalizeGuestText(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

const INTENT_STEMS = INTENT_GROUPS.map((group) => new Set(group.map((word) => stem(normalizeGuestText(word)))))

type QueryTerm = { key: string; stems: ReadonlySet<string>; weight: number }

/** The distinct parts of a question: intent groups plus remaining content words, in any order. */
export function guestQuestionTerms(query: string, previousQuery?: string | null): QueryTerm[] {
  const own = questionTerms(query, 1)
  if (!previousQuery || !guestQueryIsFollowup(query)) return own
  const keys = new Set(own.map((term) => term.key))
  return [
    ...own,
    ...questionTerms(previousQuery, FOLLOWUP_TERM_WEIGHT).filter((term) => !keys.has(term.key)),
  ].slice(0, MAX_QUERY_TERMS)
}

function questionTerms(query: string, weight: number): QueryTerm[] {
  const terms = new Map<string, QueryTerm>()
  for (const token of tokens(query)) {
    if (GUEST_QUERY_FUNCTION_WORDS.has(token)) continue
    if (/^\p{N}+$/u.test(token) ? token.length > 4 : token.length < 3) continue
    const tokenStem = stem(token)
    const groupIndex = INTENT_STEMS.findIndex((group) => group.has(tokenStem))
    if (groupIndex >= 0) {
      const key = `intent:${groupIndex}`
      if (!terms.has(key)) terms.set(key, { key, stems: INTENT_STEMS[groupIndex]!, weight })
    } else if (!terms.has(`word:${tokenStem}`)) {
      terms.set(`word:${tokenStem}`, { key: `word:${tokenStem}`, stems: new Set([tokenStem]), weight })
    }
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
    body: [place.type, place.itemType, place.areaName, place.shortDescription, place.longDescription, place.hours, ...(place.tags ?? [])]
      .filter(Boolean)
      .join(' '),
  }
}

export type GuestQuestionEvidenceRank = {
  kind: 'knowledge' | 'place'
  id: string
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
  candidates: GuestEvidenceCandidate[]
}): { terms: string[]; ranked: GuestQuestionEvidenceRank[] } {
  const terms = guestQuestionTerms(params.query, params.previousQuery)
  if (terms.length === 0 || params.candidates.length === 0)
    return { terms: terms.map((term) => term.key), ranked: [] }
  const docs = params.candidates.map((candidate) => {
    const { title, body } = candidateText(candidate)
    const stems = [
      ...Array.from({ length: TITLE_REPEAT }, () => tokens(title)).flat(),
      ...tokens(body),
    ].map(stem)
    const counts = new Map<string, number>()
    for (const value of stems) counts.set(value, (counts.get(value) ?? 0) + 1)
    return { candidate, length: stems.length, counts }
  })
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const termFrequency = (doc: (typeof docs)[number], term: QueryTerm) => {
    let tf = 0
    for (const value of term.stems) tf += doc.counts.get(value) ?? 0
    return tf
  }
  const idf = terms.map((term) => {
    const df = docs.filter((doc) => termFrequency(doc, term) > 0).length
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
  })
  // Per record, per question part: the BM25 contribution of that part.
  const contributions = docs.map((doc) =>
    terms.map((term, index) => {
      const tf = termFrequency(doc, term)
      if (tf === 0) return 0
      const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / averageLength)
      return term.weight * idf[index]! * ((tf * (BM25_K1 + 1)) / norm)
    }),
  )
  const covered = new Set<number>()
  const remaining = new Set(docs.map((_, index) => index))
  const ranked: GuestQuestionEvidenceRank[] = []
  let firstScore = 0
  while (remaining.size > 0) {
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
    if (ranked.length === 0) firstScore = bestGain
    if (bestGain < firstScore * MIN_RELATIVE_SCORE) break
    remaining.delete(best)
    const matched = contributions[best]!.flatMap((value, termIndex) => (value > 0 ? [termIndex] : []))
    for (const termIndex of matched) covered.add(termIndex)
    const { candidate } = docs[best]!
    ranked.push({
      kind: candidate.kind,
      id: candidate.id,
      score: Math.round(bestGain * 1000) / 1000,
      terms: matched.map((termIndex) => terms[termIndex]!.key),
    })
  }
  return { terms: terms.map((term) => term.key), ranked }
}

/** Question parts that none of these whole-record texts matches. */
export function uncoveredGuestQuestionTerms(params: {
  query: string
  previousQuery?: string | null
  texts: ReadonlyArray<string>
}): string[] {
  const present = new Set(params.texts.flatMap((text) => tokens(text).map(stem)))
  return guestQuestionTerms(params.query, params.previousQuery)
    .filter((term) => ![...term.stems].some((value) => present.has(value)))
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

/**
 * Whole guide records to add for this question. In DIRECTORY mode the bodies join the dynamic
 * context; in FULL mode every body is already present, so only relevant topic names are added
 * (the prompt renders guide records by name). Records already in context are never repeated.
 */
export function selectGuestQuestionEvidence<K extends { id?: string; content: string }>(params: {
  query: string
  previousQuery?: string | null
  directory: GuestVenueDirectory
  mode: 'FULL' | 'DIRECTORY' | 'NONE'
  currentDate: string
  knowledgeInContext: ReadonlyArray<K>
  placeIdsInContext: ReadonlySet<string>
  maxContextChars?: number
}): {
  knowledge: GuestDirectoryKnowledge[]
  places: GuestDirectoryPlace[]
  trace: GuestQuestionEvidenceTrace
} {
  const empty = () => ({
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
  })
  if (params.mode === 'NONE') return empty()
  const presentKnowledge = new Set(params.knowledgeInContext.flatMap((entry) => (entry.id ? [entry.id] : [])))
  const knowledgeCandidates: GuestEvidenceCandidate[] = params.directory.knowledge
    .filter((entry) => !isPastDatedGuestEvent(entry, params.currentDate))
    .map((entry) => ({ kind: 'knowledge', id: entry.id, record: entry, chars: entry.content.length }))
  // Same-name places stay name-only until identity resolution picks one; never hydrate them here.
  const nameCounts = new Map<string, number>()
  for (const place of params.directory.places) {
    const key = normalizeGuestText(place.name)
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  const placeCandidates: GuestEvidenceCandidate[] = params.directory.places
    .filter((place) => (nameCounts.get(normalizeGuestText(place.name)) ?? 0) === 1)
    .map((place) => ({
      kind: 'place',
      id: place.id,
      record: place,
      chars: (place.shortDescription?.length ?? 0) + (place.longDescription?.length ?? 0),
    }))
  const { terms, ranked } = rankGuestQuestionEvidence({
    query: params.query,
    ...(params.previousQuery !== undefined ? { previousQuery: params.previousQuery } : {}),
    candidates: [...knowledgeCandidates, ...placeCandidates],
  })
  const knowledgeById = new Map(params.directory.knowledge.map((entry) => [entry.id, entry]))
  const placeById = new Map(params.directory.places.map((place) => [place.id, place]))
  const knowledge: GuestDirectoryKnowledge[] = []
  const places: GuestDirectoryPlace[] = []
  const budgetExcludedIds: string[] = []
  const maxChars = params.maxContextChars ?? QUESTION_EVIDENCE_MAX_CONTEXT_CHARS
  let contextChars = params.knowledgeInContext.reduce((sum, entry) => sum + entry.content.length, 0)
  for (const rank of ranked) {
    if (rank.kind === 'knowledge') {
      if (presentKnowledge.has(rank.id)) continue
      const limit =
        params.mode === 'FULL'
          ? QUESTION_EVIDENCE_MAX_FOCUS_TOPICS
          : QUESTION_EVIDENCE_MAX_KNOWLEDGE_RECORDS
      const entry = knowledgeById.get(rank.id)!
      if (knowledge.length >= limit) continue
      // FULL guides already carry the body; only the name is rendered, so no body budget applies.
      if (params.mode === 'DIRECTORY') {
        if (contextChars + entry.content.length > maxChars) {
          budgetExcludedIds.push(rank.id)
          continue
        }
        contextChars += entry.content.length
      }
      knowledge.push(entry)
    } else {
      if (params.placeIdsInContext.has(rank.id)) continue
      // A FULL guide carries every place body already.
      if (params.mode !== 'DIRECTORY' || places.length >= QUESTION_EVIDENCE_MAX_PLACES) continue
      places.push(placeById.get(rank.id)!)
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
        texts: [
          ...params.knowledgeInContext.map((entry) => entry.content),
          ...knowledge.map((entry) => `${entry.title} ${entry.content}`),
          ...params.directory.places
            .filter((place) => params.placeIdsInContext.has(place.id) || places.includes(place))
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

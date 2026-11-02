// Visitor party: the people a visitor has described in their own messages ("my son is 40 inches",
// "my 9-year-old daughter") and the roles the current question gives them ("can she ride with
// him?"). Only visitor messages are read; an assistant reply is never evidence of a person.
//
// Why: in the 2026-11-01 diagnostic, typed ride facts stopped invented thresholds but answers still
// treated the 40-inch rider as the possible companion. Explicit person/role lines fixed that in a
// small manual test. This module produces those lines deterministically. It binds a role only when
// the wording states it; otherwise the role stays unresolved and the model is told so.

export type GuestPartyPerson = {
  /** Stable within one conversation projection: P1, P2, ... in order of first mention. */
  id: string
  /** The visitor's own words for the person ("my son", "Maya", "the 7-year-old"). */
  label: string
  gender: 'male' | 'female' | null
  heightInches: number | null
  heightText: string | null
  ageYears: number | null
  /** 1-based visitor message index (oldest first) where each attribute was last stated. */
  heightMessage: number | null
  ageMessage: number | null
  /** The visitor is talking about themselves. */
  self: boolean
}

export type GuestPartyRoleBinding = {
  personId: string
  /** "together": named as riding or going together; who needs whom is decided by the rules. */
  role: 'rider' | 'companion' | 'alone' | 'participant' | 'together'
}

export type GuestVisitorParty = {
  persons: GuestPartyPerson[]
  /** Roles stated by the current message; empty when it states none. */
  roles: GuestPartyRoleBinding[]
  /** The current message refers to someone (he, she, the older one) who could not be resolved. */
  unresolvedReference: string | null
}

const MALE =
  /^(?:son|boy|husband|dad|father|grandpa|grandfather|grandson|nephew|brother|stepson|boyfriend|he)$/u
const FEMALE =
  /^(?:daughter|girl|wife|mom|mother|grandma|grandmother|granddaughter|niece|sister|stepdaughter|girlfriend|she)$/u

const RELATION = String.raw`(?:son|daughter|kid|child|boy|girl|toddler|baby|husband|wife|partner|mom|dad|mother|father|grandma|grandpa|grandmother|grandfather|grandson|granddaughter|grandkid|grandchild|niece|nephew|friend|brother|sister|stepson|stepdaughter|cousin|teen|teenager|neighbor|neighbour|aunt|uncle|godson|goddaughter|older one|younger one|oldest|youngest|little one|middle one)`

const HEIGHT = String.raw`(\d{2,3}(?:\.\d)?)\s*(?:in\b|inch(?:es)?\b|pouces?\b|"|”|cm\b)|(\d)\s*(?:ft|feet|foot|')\s*(\d{1,2})?\s*(?:in\b|inch(?:es)?\b|"|”)?`
const AGE = String.raw`(\d{1,2})\s*(?:years?(?:\s+old)?\b|yrs?\b|yo\b|ans\b|-year-old\b|year-old\b)`
const FRENCH_RELATIONS: Readonly<Record<string, string>> = {
  fils: 'son',
  fille: 'daughter',
  sœur: 'sister',
  soeur: 'sister',
  frère: 'brother',
  mere: 'mother',
  mère: 'mother',
  père: 'father',
  pere: 'father',
  cousin: 'cousin',
  cousine: 'cousin',
  ami: 'friend',
  amie: 'friend',
  enfant: 'child',
}

// "my son", "my 7-year-old son", "my 7-year-old", "Maya", "I"/"I'm"
const MENTION = new RegExp(
  String.raw`\b(?:[Mm]y|[Oo]ur|[Hh]is|[Hh]er|[Tt]heir|[Aa]n?|[Tt]he)\s+(?:(\d{1,2})[- ]?(?:year[- ]old|yo)\s+)?(${RELATION}s?)\b|\b(?:[Mm]y|[Oo]ur|[Tt]he)\s+(\d{1,2})[- ]?year[- ]old\b|\b(I(?:'m|’m| am)|me)(?=\s|,|$)|\b([A-Z][a-z]{2,14})\s+(?=is\b|was\b|has\b|measures\b|stands\b|at\s+\d|\(|,)|\b(?:[Mm]on|[Mm]a|[Nn]otre)\s+(${Object.keys(FRENCH_RELATIONS).join('|')})(?:\s+de\s+(\d{1,2})\s+ans)?\b|\b([Jj]e)(?=\s|,|$)|\b([Hh]e|[Ss]he|[Ii]l|[Ee]lle)(?=\s+(?:is|was|has|measures|stands|turned|a|mesure)\b)`,
  'gu',
)

const NOT_NAMES = new Set([
  'The',
  'This',
  'That',
  'There',
  'What',
  'Which',
  'Where',
  'When',
  'How',
  'Who',
  'Can',
  'Could',
  'Would',
  'Should',
  'Does',
  'Is',
  'It',
  'He',
  'She',
  'They',
  'And',
  'But',
  'Also',
  'Then',
  'Our',
  'My',
  'Your',
  'Its',
  'Today',
  'Tomorrow',
])

function heightFrom(text: string): { inches: number; text: string } | null {
  const match = text.match(new RegExp(HEIGHT, 'iu'))
  if (!match) return null
  if (match[1]) {
    const value = Number(match[1])
    const cm = /cm/iu.test(match[0])
    return { inches: cm ? Math.round((value / 2.54) * 10) / 10 : value, text: match[0].trim() }
  }
  const inches = Number(match[2]) * 12 + Number(match[3] ?? 0)
  return inches >= 24 && inches <= 96 ? { inches, text: match[0].trim() } : null
}

function ageFrom(text: string): number | null {
  const match = text.match(new RegExp(AGE, 'iu'))
  return match ? Number(match[1]) : null
}

function genderOf(label: string): GuestPartyPerson['gender'] {
  const word =
    label
      .toLocaleLowerCase()
      .replace(/^(?:my|our)\s+/u, '')
      .replace(/s$/u, '')
      .split(/\s+/u)
      .at(-1) ?? ''
  if (MALE.test(word)) return 'male'
  if (FEMALE.test(word)) return 'female'
  return null
}

function keyOf(label: string): string {
  return label
    .toLocaleLowerCase()
    .replace(/^(?:my|our|the)\s+/u, '')
    .replace(/\b\d{1,2}[- ]?year[- ]old\s+/u, '')
    .trim()
}

type Mention = {
  label: string
  index: number
  end: number
  self: boolean
  age: number | null
  needsMeasurement?: boolean
  /** A pronoun can update one already described person; it never creates a new one. */
  reference?: boolean
}

function mentionsIn(text: string): Mention[] {
  const mentions: Mention[] = []
  for (const match of text.matchAll(MENTION)) {
    const index = match.index ?? 0
    if (match[2]) {
      // A plural ("my kids") is a group, not one person.
      if (/s$/u.test(match[2]) && !/^(?:boss)$/u.test(match[2])) continue
      const owned = /^(?:my|our|his|her|their)\b/iu.test(match[0])
      const owner = match[0].match(/^(?:his|her|their)\b/iu)?.[0]?.toLowerCase() ?? 'my'
      mentions.push({
        label: owned
          ? `${owner} ${match[2]}`
          : `the ${match[1] ? `${match[1]}-year-old ` : ''}${match[2]}`,
        index,
        end: index + match[0].length,
        self: false,
        age: match[1] ? Number(match[1]) : null,
        // "the boy" or "a friend" is usually a reference; it needs a measurement to be a person.
        needsMeasurement: !owned,
      })
    } else if (match[3]) {
      mentions.push({
        label: `the ${match[3]}-year-old`,
        index,
        end: index + match[0].length,
        self: false,
        age: Number(match[3]),
      })
    } else if (match[4]) {
      mentions.push({
        label: 'the visitor',
        index,
        end: index + match[0].length,
        self: true,
        age: null,
      })
    } else if (match[5] && /^(?:He|She|Il|Elle)$/u.test(match[5])) {
      mentions.push({
        label: match[5],
        index,
        end: index + match[0].length,
        self: false,
        age: null,
        reference: true,
      })
    } else if (match[5] && !NOT_NAMES.has(match[5])) {
      mentions.push({
        label: match[5],
        index,
        end: index + match[0].length,
        self: false,
        age: null,
      })
    } else if (match[6]) {
      mentions.push({
        label: `my ${FRENCH_RELATIONS[match[6]]}`,
        index,
        end: index + match[0].length,
        self: false,
        age: match[7] ? Number(match[7]) : null,
      })
    } else if (match[8]) {
      mentions.push({
        label: 'the visitor',
        index,
        end: index + match[0].length,
        self: true,
        age: null,
      })
    } else if (match[9]) {
      mentions.push({
        label: match[9],
        index,
        end: index + match[0].length,
        self: false,
        age: null,
        reference: true,
      })
    }
  }
  return mentions.sort((left, right) => left.index - right.index)
}

// The clause that belongs to a mention: from the mention to the next mention or clause break.
function clauseAfter(text: string, mention: Mention, next: Mention | undefined): string {
  const stop = next ? next.index : text.length
  const rest = text.slice(mention.index, stop)
  const cut = rest.search(/[;!?]|\.(?!\d)|\bbut\b/u)
  return cut > 0 ? rest.slice(0, cut) : rest
}

function hypotheticalMeasurement(text: string, mention: Mention, clause: string): boolean {
  // Include the sentence prefix: starting at "he" would erase the "what if" that
  // makes a proposed measurement nonfactual. Decimal points are not sentence breaks.
  const prefix =
    text
      .slice(0, mention.index)
      .split(/[;!?\n]|\.(?!\d)/u)
      .at(-1) ?? ''
  const conditional =
    /\b(?:if|unless|suppose|supposing|assuming|imagine|pretend|hypothetically|si|supposons)\b/iu
  return (
    conditional.test(prefix) ||
    conditional.test(clause) ||
    /\b(?:could|would|might|may)\s+(?:be|measure)\b/iu.test(clause)
  )
}

/**
 * Builds the party from the visitor's own messages, oldest first. The last message is the current
 * question; its stated roles are bound when the wording is explicit.
 */
export function buildGuestVisitorParty(visitorMessages: ReadonlyArray<string>): GuestVisitorParty {
  const persons: GuestPartyPerson[] = []
  const byKey = new Map<string, GuestPartyPerson>()
  // A conversation that talks in ages reads "my sister is 19" as an age.
  const conversationUsesAges = visitorMessages.some((message) =>
    /\b\d{1,2}[- ]?year[- ]old\b|\byears? old\b|\bages?\b/iu.test(message),
  )
  // Bare numbers listed for "two kids, 40 and 48 inches" become unnamed children.
  visitorMessages.forEach((message, messageIndex) => {
    const mentions = mentionsIn(message)
    // "my son is 40 inches and my daughter is 48": a bare 30-79 after "is" in a message that states
    // a height in inches elsewhere is the same unit.
    const messageUsesInches =
      /\d{2}(?:\.\d)?\s*(?:in\b|inch(?:es)?\b|"|”)|\btall\b|\bheight\b/iu.test(message)
    mentions.forEach((mention, index) => {
      const rawClause = clauseAfter(message, mention, mentions[index + 1])
      const hypothetical = hypotheticalMeasurement(message, mention, rawClause)
      // A descriptor ("my 16-year-old sister") still identifies the person when the
      // hypothetical is about their role. Predicative measurements stay unasserted.
      if (hypothetical && mention.age === null) return
      const measuredClause = hypothetical ? '' : rawClause
      const parts = measuredClause.split(/\b(?:and|but)\b|[,;]/iu)
      const uncertain =
        /\b(?:not|no|never|pas|jamais|unknown|uncertain|unclear|unsure|maybe|perhaps|possibly|might)\b|n['’]t\b/iu
      const rejected = parts.filter((part) => uncertain.test(part))
      // A denied or uncertain measurement is not a positive fact. Keep independent
      // affirmative clauses available, without joining them into a paired value.
      const clause = rejected.length
        ? parts.filter((part) => !uncertain.test(part)).join('; ')
        : measuredClause
      const bare = messageUsesInches
        ? clause.match(
            /\b(?:is|was|measures|stands at|at)\s+([3-7]\d(?:\.\d)?)\b(?!\s*(?:years?|yrs?|yo|-year|cm|ft|feet|'|\$))/iu,
          )
        : null
      const height =
        heightFrom(clause) ?? (bare ? { inches: Number(bare[1]), text: `${bare[1]} in` } : null)
      const bareAge =
        !height && !messageUsesInches && conversationUsesAges
          ? clause.match(
              /\b(?:is|am|I'm|I’m|turned|just turned)\s+(\d{1,2})\b(?!\s*(?:in\b|inch|"|”|cm|ft|feet|'|\$|%|dollars?\b|tokens?\b|percent\b))/iu,
            )
          : null
      // A paired age and explicit height ("Maya is 19 and 46 inches") has two attributes,
      // not an unnamed second height. Require the conjunction and an explicit height unit;
      // an isolated number or a list of alternative heights remains unresolved.
      const pairedAge = clause.match(
        /\b(?:is|am|I'm|I’m)\s+(\d{1,2})\s*(?:,\s*|and\s+)(?:is\s+)?\d{2,3}(?:\.\d)?\s*(?:in\b|inch(?:es)?\b|cm\b|"|”)/iu,
      )
      const age =
        mention.age ??
        ageFrom(clause) ??
        (pairedAge ? Number(pairedAge[1]) : bareAge ? Number(bareAge[1]) : null)
      // A name, "I", or "the boy" only becomes a person when the clause states a measurement.
      const referenced = mention.reference ? resolveReference(mention.label, persons) : null
      if (mention.reference && (!referenced || referenced === 'ambiguous')) return
      const owner = referenced && referenced !== 'ambiguous' ? referenced : null
      const key = mention.self ? 'self' : keyOf(owner?.label ?? mention.label)
      let person = byKey.get(key)
      if (person)
        for (const denied of rejected.filter((part) =>
          /\b(?:not|never|pas|jamais)\b|n['’]t\b/iu.test(part),
        )) {
          if (ageFrom(denied) === person.ageYears) {
            person.ageYears = null
            person.ageMessage = null
          }
          if (heightFrom(denied)?.inches === person.heightInches) {
            person.heightInches = null
            person.heightText = null
            person.heightMessage = null
          }
        }
      if (
        (mention.self || mention.needsMeasurement || /^[A-Z]/u.test(mention.label)) &&
        !height &&
        age === null
      )
        return
      if (!person) {
        person = {
          id: `P${persons.length + 1}`,
          label: mention.label,
          gender: genderOf(mention.label),
          heightInches: null,
          heightText: null,
          ageYears: null,
          heightMessage: null,
          ageMessage: null,
          self: mention.self,
        }
        persons.push(person)
        byKey.set(key, person)
      }
      if (height) {
        person.heightInches = height.inches
        person.heightText = height.text
        person.heightMessage = messageIndex + 1
      }
      if (age !== null) {
        person.ageYears = age
        person.ageMessage = messageIndex + 1
      }
    })
    // "two kids who are 40 and 48 inches": unnamed, ordered by the visitor's listing.
    const listed = message.match(
      /\b(?:two|2|three|3)\s+(?:kids|children|boys|girls|grandkids)\b[^.?!]{0,40}?\b(\d{2,3})\s*(?:in(?:ches)?|")?\s*(?:,|and)\s*(\d{2,3})\s*(?:in\b|inch(?:es)?\b|")/iu,
    )
    if (listed && mentions.length === 0)
      for (const value of [listed[1], listed[2]]) {
        const person: GuestPartyPerson = {
          id: `P${persons.length + 1}`,
          label: `the ${value}-inch child`,
          gender: null,
          heightInches: Number(value),
          heightText: `${value} in`,
          ageYears: null,
          heightMessage: messageIndex + 1,
          ageMessage: null,
          self: false,
        }
        persons.push(person)
        byKey.set(keyOf(person.label), person)
      }
  })
  const current = visitorMessages.at(-1) ?? ''
  const { roles, unresolvedReference } = bindRoles(current, persons)
  return { persons, roles, unresolvedReference }
}

function resolveReference(
  word: string,
  persons: GuestPartyPerson[],
): GuestPartyPerson | null | 'ambiguous' {
  const lower = word.toLocaleLowerCase()
  const nonSelf = persons.filter((person) => !person.self)
  const gendered = (gender: 'male' | 'female') => {
    const matches = nonSelf.filter((person) => person.gender === gender)
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) return 'ambiguous' as const
    // "my 7-year-old ... can she": the only described person whose gender was never stated.
    const unknown = nonSelf.filter((person) => person.gender === null)
    return unknown.length === 1 && nonSelf.length === 1 ? unknown[0]! : null
  }
  if (/^(?:he|him|his|il)$/u.test(lower)) return gendered('male')
  if (/^(?:she|her|hers|elle)$/u.test(lower)) return gendered('female')
  const measured = nonSelf.filter(
    (person) => person.heightInches !== null || person.ageYears !== null,
  )
  const metric = (person: GuestPartyPerson) => person.ageYears ?? person.heightInches ?? 0
  if (
    /^(?:the )?(?:older|oldest|taller|tallest|big(?:ger)?) (?:one|kid|child)?$|^(?:the )?(?:older|oldest)$/u.test(
      lower,
    ) &&
    measured.length >= 2
  )
    return [...measured].sort((left, right) => metric(right) - metric(left))[0]!
  if (
    /^(?:the )?(?:younger|youngest|shorter|shortest|little|smaller) (?:one|kid|child)?$|^(?:the )?(?:younger|youngest)$/u.test(
      lower,
    ) &&
    measured.length >= 2
  )
    return [...measured].sort((left, right) => metric(left) - metric(right))[0]!
  if (/^(?:i|me|myself)$/u.test(lower)) return persons.find((person) => person.self) ?? null
  const direct = persons.find(
    (person) => keyOf(person.label) === keyOf(lower) || person.label.toLocaleLowerCase() === lower,
  )
  return direct ?? null
}

const PERSON_WORD = String.raw`(?:(?:my|our|the)\s+\d{1,2}[- ]year[- ]old(?!\s+${RELATION})|(?:(?:my|our|the)\s+)?(?:\d{1,2}[- ]year[- ]old\s+)?(?:${RELATION}|he|she|him|her|i|me|[A-Z][a-z]{2,14}|(?:older|younger|oldest|youngest|taller|shorter|little|bigger|smaller)(?: one| kid| child)?))`

const REFERENCE_WORD = new RegExp(
  String.raw`^(?:he|she|him|her|they|them|(?:the )?(?:older|younger|oldest|youngest|taller|shorter|little|bigger|smaller)(?: one| kid| child)?|(?:my|our|the) (?:\d{1,2}[- ]year[- ]old\s+)?${RELATION})$`,
  'iu',
)

function bindRoles(
  message: string,
  persons: GuestPartyPerson[],
): { roles: GuestPartyRoleBinding[]; unresolvedReference: string | null } {
  const roles: GuestPartyRoleBinding[] = []
  let unresolvedReference: string | null = null
  const personFor = (word: string | undefined) => {
    if (!word) return null
    const cleaned = word
      .trim()
      .replace(/^(?:my|our|the)\s+/iu, (prefix) => prefix.toLocaleLowerCase())
    return (
      resolveReference(cleaned.replace(/^(?:the)\s+/u, ''), persons) ??
      resolveReference(cleaned, persons)
    )
  }
  const bind = (word: string | undefined, role: GuestPartyRoleBinding['role']) => {
    if (!word) return
    const resolved = personFor(word)
    if (resolved === 'ambiguous' || resolved === null) {
      if (REFERENCE_WORD.test(word.trim())) unresolvedReference ??= word.trim()
      return
    }
    if (!roles.some((binding) => binding.personId === resolved.id && binding.role === role))
      roles.push({ personId: resolved.id, role })
  }
  // A two-person construction is atomic: a venue name matching PERSON_WORD
  // must never leave the real person assigned one side of an imaginary pair.
  const bindPair = (
    first: string | undefined,
    firstRole: GuestPartyRoleBinding['role'],
    second: string | undefined,
    secondRole: GuestPartyRoleBinding['role'],
  ) => {
    const left = personFor(first)
    const right = personFor(second)
    if (!left || left === 'ambiguous' || !right || right === 'ambiguous') return
    bind(first, firstRole)
    bind(second, secondRole)
  }
  // "can <A> ride (it|the X)? with <B>"
  const withPattern = new RegExp(
    String.raw`\b(?:can|could|may|would)\s+(${PERSON_WORD})\s+(?:ride|go(?: on)?|do|join|take(?: part)?)\b[\s\S]{0,40}?\b(?:with|alongside|next to)\s+(${PERSON_WORD})\b`,
    'iu',
  )
  // "Ride with" is symmetric: in "can my 16-year-old cousin ride with Ben?" the cousin is the
  // companion for the shorter Ben. Grammar names who rides together, never who needs whom
  // (2026-11-01 paid run: a grammatical rider/companion binding swapped the roles in 2/2 answers).
  // Each person's own height and age decide the roles.
  const withMatch = message.match(withPattern)
  if (withMatch) {
    bindPair(withMatch[1], 'together', withMatch[2], 'together')
  }
  // "can <B> take/bring/ride with <A>" where B is the companion: "can my daughter take him on"
  const takePattern = new RegExp(
    String.raw`\b(?:can|could|may)\s+(${PERSON_WORD})\s+(?:take|bring|accompany|supervise|chaperone)\s+(${PERSON_WORD})\b`,
    'iu',
  )
  const takeMatch = !withMatch ? message.match(takePattern) : null
  if (takeMatch) {
    bindPair(takeMatch[1], 'companion', takeMatch[2], 'rider')
  }
  // "<B> as (his|her|their|a) companion", "can <B> be the companion"
  const asCompanion = new RegExp(
    String.raw`\b(${PERSON_WORD})\s+(?:be|count as|go as|act as|as)\s+(?:a |the |his |her |their )?(?:(?:on[- ]ice|in[- ]room|adult|designated|supervising)\s+)*(?:companion|chaperone|supervising rider)\b`,
    'iu',
  )
  const asMatch = message.match(asCompanion)
  if (asMatch) bind(asMatch[1], 'companion')
  // "can <A> ride (it) alone / by himself"
  const alone = new RegExp(
    String.raw`\b(${PERSON_WORD})\s+(?:ride|go(?: on)?|do)\b[\s\S]{0,30}?\b(?:alone|solo|by (?:himself|herself|themselves|myself)|on (?:his|her|their|my) own)\b`,
    'iu',
  )
  const aloneMatch = message.match(alone)
  if (aloneMatch) bind(aloneMatch[1], 'alone')
  // A bare pronoun subject with no role pattern: "can he ride it?"
  const unresolvedCompanionWording =
    /\b(?:be|as)\b[^.!?]{0,60}\b(?:companion|chaperone|supervising rider)\b/iu.test(message)
  if (!roles.length && !asMatch && !unresolvedCompanionWording) {
    const subject = message.match(
      new RegExp(
        String.raw`\b(?:can|could|may|is|will)\s+(${PERSON_WORD})\s+(?:ride|go|do|join|try|be|get|see|enter)\b`,
        'iu',
      ),
    )
    if (subject) bind(subject[1], 'participant')
  }
  return { roles, unresolvedReference }
}

/** The party as prompt lines (escaped by the caller). Empty when no person was described. */
export function renderGuestVisitorParty(party: GuestVisitorParty): string[] {
  if (!party.persons.length) return []
  const lines = party.persons.map((person) => {
    const facts = [
      person.heightInches !== null
        ? `height ${person.heightText ?? `${person.heightInches} in`}${person.heightText && /cm|ft|feet|'/iu.test(person.heightText) ? ` (about ${person.heightInches} in)` : ''} (visitor message ${person.heightMessage})`
        : "height unavailable in this projection; do not use another person's height",
      person.ageYears !== null
        ? `age ${person.ageYears} (visitor message ${person.ageMessage})`
        : "age unavailable in this projection; do not use another person's age",
    ]
    return `${person.id} "${person.label}": ${facts.join('; ')}`
  })
  const names = new Map(
    party.persons.map((person) => [person.id, `${person.id} (${person.label})`]),
  )
  const together = party.roles.filter((binding) => binding.role === 'together')
  const assigned = party.roles.filter((binding) => binding.role !== 'together')
  if (assigned.length)
    lines.push(
      `This question's roles: ${assigned.map((binding) => `${binding.role} = ${names.get(binding.personId)}`).join('; ')}.`,
    )
  if (together.length)
    lines.push(
      `Riding or going together: ${together.map((binding) => names.get(binding.personId)).join(' and ')}. The wording does not say who is the rider and who is the companion: decide from each person's own height and age against the rule, and say which person each requirement applies to.`,
    )
  if (!party.roles.length)
    lines.push(
      'This projection computed no role binding; use relationships and roles explicitly stated by the visitor. Missing measurements here do not make those statements unknown.',
    )
  if (party.unresolvedReference)
    lines.push(
      `Unresolved reference: "${party.unresolvedReference}" could mean more than one person, or no described person.`,
    )
  return lines
}

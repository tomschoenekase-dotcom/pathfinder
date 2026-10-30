/** Selection hints only; never serialize facet values as answer facts. */
export type Facets = {
  minAge: number | null
  maxAge: number | null
  minHeightCm: number | null
  adultRequired: boolean | null
  durationMinutes: number | null
  price: { amount: number; currency: 'USD' | 'EUR' | 'GBP' } | null
  access: 'step-free' | 'stairs-only' | null
  included: boolean | null
  kind: 'ride' | 'exhibit' | 'food' | 'show' | null
}
export type FacetKey = keyof Facets
const FACET_KEYS: FacetKey[] = [
  'minAge',
  'maxAge',
  'minHeightCm',
  'adultRequired',
  'durationMinutes',
  'price',
  'access',
  'included',
  'kind',
]
const NUMBER = '(\\d+(?:\\.\\d+)?)'

/** Generic natural-language hints. These NEVER contribute to hard values or statement counts. */
function naturalSoftClause(clause: string): Partial<Facets> {
  const soft: Partial<Facets> = {}
  // Refusal here only limits soft ranking. It is not proof that unrecognized exceptions are absent.
  if (
    /\b(?:if|unless|except|when|provided|depending|may|might|usually|recommended|about|approximately|starting|optional|younger|shorter|guardian|alternative)\b|\b(?:under|below)\s+\d|\bfrom\s+(?:USD|EUR|GBP|[$€£])/iu.test(
      clause,
    )
  )
    return soft
  const exact = (pattern: string) => clause.match(new RegExp(`^${pattern}$`, 'iu'))
  let match =
    exact(`(?:riders|visitors|guests|participants) must be at least ${NUMBER} years? old`) ??
    exact(`(?:the )?minimum age is ${NUMBER} years?(?: old)?`) ??
    exact(`ages? ${NUMBER} (?:and (?:up|older)|or older)`)
  if (match) soft.minAge = Number(match[1])
  match = exact(`(?:the )?maximum age is ${NUMBER} years?(?: old)?`)
  if (match) soft.maxAge = Number(match[1])
  match = exact(`(?:for )?ages? ${NUMBER} (?:to|through|-) ${NUMBER}(?: years?(?: old)?)?`)
  if (match) {
    soft.minAge = Number(match[1])
    soft.maxAge = Number(match[2])
  }
  match =
    exact(
      `(?:riders|visitors|guests|participants) must be at least ${NUMBER} (inches?|in|cm|centimeters?) tall`,
    ) ?? exact(`(?:the )?minimum height is ${NUMBER} (inches?|in|cm|centimeters?)`)
  if (match)
    soft.minHeightCm = Number(match[1]) * (/^(?:in|inch|inches)$/iu.test(match[2]!) ? 2.54 : 1)
  if (
    /^(?:(?:an? )?accompanying adult is required|(?:children|riders|visitors|guests) must be accompanied by an adult|adult accompaniment is required)$/iu.test(
      clause,
    )
  )
    soft.adultRequired = true
  if (/^(?:adult accompaniment is not required|no accompanying adult is required)$/iu.test(clause))
    soft.adultRequired = false
  match =
    exact(
      `(?:the |this )?(?:ride|show|tour|experience|activity) (?:lasts|takes) ${NUMBER} (?:minutes?|mins?)`,
    ) ?? exact(`(?:the )?duration is ${NUMBER} (?:minutes?|mins?)`)
  if (match) soft.durationMinutes = Number(match[1])
  match =
    exact(`(?:the )?(?:price|ticket price) is (USD|EUR|GBP) ${NUMBER}`) ??
    exact(`tickets? cost (USD|EUR|GBP) ${NUMBER}`)
  if (match)
    soft.price = {
      currency: match[1]!.toUpperCase() as 'USD' | 'EUR' | 'GBP',
      amount: Number(match[2]),
    }
  if (
    /^(?:the |this )?(?:route|entrance|ride|exhibit|experience|attraction) is step[- ]free$/iu.test(
      clause,
    )
  )
    soft.access = 'step-free'
  if (
    /^(?:(?:the |this )?(?:route|entrance|ride|exhibit|experience|attraction) is stairs[- ]only|access is by stairs only)$/iu.test(
      clause,
    )
  )
    soft.access = 'stairs-only'
  if (
    /^(?:(?:the |this )?(?:ride|exhibit|show|experience|attraction) is )?included in (?:general )?admission$/iu.test(
      clause,
    )
  )
    soft.included = true
  if (
    /^(?:(?:the |this )?(?:ride|exhibit|show|experience|attraction) is )?not included in (?:general )?admission$/iu.test(
      clause,
    )
  )
    soft.included = false
  match = exact(
    `(?:this|the attraction|the experience) is (?:a|an) (ride|exhibit|show|food outlet)`,
  )
  if (match)
    soft.kind =
      match[1]!.toLowerCase() === 'food outlet'
        ? 'food'
        : (match[1]!.toLowerCase() as Facets['kind'])
  for (const key of ['minAge', 'maxAge', 'minHeightCm', 'durationMinutes'] as const)
    if (soft[key] !== undefined && !Number.isFinite(soft[key])) delete soft[key]
  if (soft.price && !Number.isFinite(soft.price.amount)) delete soft.price
  return soft
}

function unknownFacets(): Facets {
  return {
    minAge: null,
    maxAge: null,
    minHeightCm: null,
    adultRequired: null,
    durationMinutes: null,
    price: null,
    access: null,
    included: null,
    kind: null,
  }
}
export type RecordFacetExtraction = {
  hard: Facets
  soft: Facets
  completeGrammar: boolean
}

/** Hard constraints require complete grammar. Soft hints only order whole record hydration. */
export function extractRecordFacetHints(text: string): RecordFacetExtraction {
  const result: Facets = {
    minAge: null,
    maxAge: null,
    minHeightCm: null,
    adultRequired: null,
    durationMinutes: null,
    price: null,
    access: null,
    included: null,
    kind: null,
  }
  // Only a completely recognized record grammar may contribute exclusionary hints.
  // Arbitrary unparsed prose can express an exception without any anticipated keyword.
  const values = new Map<FacetKey, unknown[]>()
  const naturalValues = new Map<FacetKey, unknown[]>()
  let completeGrammar = true
  const set = (key: FacetKey, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return
    if (key === 'price' && !Number.isFinite((value as { amount: number }).amount)) return
    const bucket = values.get(key) ?? []
    bucket.push(value)
    values.set(key, bucket)
  }
  const numeric = (clause: string, expression: string): RegExpMatchArray | null =>
    clause.match(new RegExp(`^${expression}$`, 'iu'))
  const clauses = text
    .normalize('NFKC')
    .split(/[;\n]|\.(?:\s+|$)/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
  for (const clause of clauses) {
    const natural = naturalSoftClause(clause)
    for (const key of FACET_KEYS)
      if (natural[key] !== undefined && natural[key] !== null) {
        const bucket = naturalValues.get(key) ?? []
        bucket.push(natural[key])
        naturalValues.set(key, bucket)
      }
    const before = [...values.values()].reduce((sum, bucket) => sum + bucket.length, 0)
    let match = numeric(clause, `minimum age\\s*:\\s*${NUMBER}\\s*years?`)
    if (match) set('minAge', Number(match[1]))
    match = numeric(clause, `maximum age\\s*:\\s*${NUMBER}\\s*years?`)
    if (match) set('maxAge', Number(match[1]))
    match = numeric(clause, `minimum height\\s*:\\s*${NUMBER}\\s*(cm|centimeters?|inches?|in)`)
    if (match)
      set('minHeightCm', Number(match[1]) * (/^(?:in|inch|inches)$/iu.test(match[2]!) ? 2.54 : 1))
    match = numeric(clause, `duration\\s*:\\s*${NUMBER}\\s*(?:minutes?|mins?)`)
    if (match) set('durationMinutes', Number(match[1]))
    match = numeric(clause, `price\\s*:\\s*(USD|EUR|GBP)\\s*${NUMBER}`)
    if (match) set('price', { amount: Number(match[2]), currency: match[1]!.toUpperCase() })
    if (/^adult accompaniment\s*:\s*required$/iu.test(clause)) set('adultRequired', true)
    if (/^adult accompaniment\s*:\s*not required$/iu.test(clause)) set('adultRequired', false)
    if (/^access\s*:\s*step[- ]free$/iu.test(clause)) set('access', 'step-free')
    if (/^access\s*:\s*stairs[- ]only$/iu.test(clause)) set('access', 'stairs-only')
    if (/^included in admission\s*:\s*yes$/iu.test(clause)) set('included', true)
    if (/^included in admission\s*:\s*no$/iu.test(clause)) set('included', false)
    const kind = clause.match(/^kind\s*:\s*(ride|exhibit|food|show)$/iu)
    if (kind) set('kind', kind[1]!.toLowerCase())
    const after = [...values.values()].reduce((sum, bucket) => sum + bucket.length, 0)
    // Even apparently decorative unsupported prose can qualify earlier clauses.
    // Do not use a keyword blacklist as evidence that no exception exists.
    if (after === before) completeGrammar = false
  }
  for (const key of FACET_KEYS) {
    const bucket = values.get(key)
    if (!bucket?.length) continue
    // Repeated identical statements are harmless; conflicting statements are unknown.
    if (bucket.every((value) => JSON.stringify(value) === JSON.stringify(bucket[0])))
      Object.assign(result, { [key]: bucket[0] })
  }
  // Reject inconsistent ranges, impossible numbers and unsupported negative syntax.
  if (result.minAge !== null && result.maxAge !== null && result.minAge > result.maxAge) {
    result.minAge = null
    result.maxAge = null
  }
  const soft = unknownFacets()
  for (const key of FACET_KEYS) {
    const bucket = [...(values.get(key) ?? []), ...(naturalValues.get(key) ?? [])]
    if (
      bucket.length &&
      bucket.every((value) => JSON.stringify(value) === JSON.stringify(bucket[0]))
    )
      Object.assign(soft, { [key]: bucket[0] })
  }
  if (soft.minAge !== null && soft.maxAge !== null && soft.minAge > soft.maxAge) {
    soft.minAge = null
    soft.maxAge = null
  }
  return { hard: completeGrammar ? { ...result } : unknownFacets(), soft, completeGrammar }
}

/** Compatibility accessor: selection failures can only use hard hints. */
export function extractRecordFacets(text: string): Facets {
  return extractRecordFacetHints(text).hard
}

export type FacetConstraints = {
  ageYears?: number
  heightCm?: number
  adultPresent?: boolean
  maxDurationMinutes?: number
  maxPrice?: { amount: number; currency: 'USD' | 'EUR' | 'GBP' }
  access?: 'step-free' | 'stairs-only'
  included?: boolean
  kind?: Facets['kind']
}
export type FacetRecord = {
  /** Namespaced, e.g. knowledge:abc or place:abc, never a bare cross-kind ID. */
  key: string
  facets: Facets
  /** Non-authoritative hints may reorder unknowns, never exclude them or establish counts. */
  softFacets?: Facets
  /** Exact whole rendered-body cost, including source wrapper; measured after live hydration. */
  chars: number
}

export function classifyFacets(
  facets: Facets,
  query: FacetConstraints,
): {
  failures: FacetKey[]
  unknown: FacetKey[]
} {
  const failures: FacetKey[] = []
  const unknown: FacetKey[] = []
  const check = (key: FacetKey, required: boolean, passes: boolean) => {
    if (!required) return
    if (facets[key] === null) unknown.push(key)
    else if (!passes) failures.push(key)
  }
  check('minAge', query.ageYears !== undefined, query.ageYears! >= facets.minAge!)
  check('maxAge', query.ageYears !== undefined, query.ageYears! <= facets.maxAge!)
  check('minHeightCm', query.heightCm !== undefined, query.heightCm! >= facets.minHeightCm!)
  check(
    'adultRequired',
    query.adultPresent !== undefined,
    facets.adultRequired !== true || query.adultPresent === true,
  )
  check(
    'durationMinutes',
    query.maxDurationMinutes !== undefined,
    facets.durationMinutes! <= query.maxDurationMinutes!,
  )
  if (query.maxPrice) {
    if (!facets.price || facets.price.currency !== query.maxPrice.currency) unknown.push('price')
    else if (facets.price.amount > query.maxPrice.amount) failures.push('price')
  }
  check('access', query.access !== undefined, facets.access === query.access)
  check('included', query.included !== undefined, facets.included === query.included)
  check('kind', query.kind !== undefined && query.kind !== null, facets.kind === query.kind)
  return { failures, unknown }
}

/** Positive compatible hint count is a ranking score only, never an eligibility certificate. */
export function softFacetPriority(facets: Facets | undefined, query: FacetConstraints): number {
  if (!facets) return 0
  const requested =
    (query.ageYears !== undefined ? 2 : 0) +
    Number(query.heightCm !== undefined) +
    Number(query.adultPresent !== undefined) +
    Number(query.maxDurationMinutes !== undefined) +
    Number(query.maxPrice !== undefined) +
    Number(query.access !== undefined) +
    Number(query.included !== undefined) +
    Number(query.kind !== undefined && query.kind !== null)
  const { failures, unknown } = classifyFacets(facets, query)
  return requested - failures.length - unknown.length
}

export type FacetSelection = {
  selectedKeys: string[]
  requiredKeys: string[]
  governingKeys: string[]
  omittedKeys: string[]
  selectionComplete: boolean
  usedChars: number
}

/** No hidden top-k. Unknowns and exactly-one-failure boundaries remain in the finite union. */
export function selectFacetRecords(params: {
  records: readonly FacetRecord[]
  constraints: FacetConstraints
  governingKeys: readonly string[]
  maxChars: number
  alreadyUsedChars?: number
}): FacetSelection {
  if (
    !Number.isFinite(params.maxChars) ||
    params.maxChars < 0 ||
    !Number.isFinite(params.alreadyUsedChars ?? 0) ||
    (params.alreadyUsedChars ?? 0) < 0 ||
    (params.alreadyUsedChars ?? 0) > params.maxChars
  )
    throw new Error('Facet evidence budgets must be finite non-negative character counts')
  const rows = [...new Map(params.records.map((row) => [row.key, row])).values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  )
  const governing = new Set(params.governingKeys)
  const buckets = new Map<string, FacetRecord[]>()
  for (const row of rows) {
    if (governing.has(row.key)) continue
    const classification = classifyFacets(row.facets, params.constraints)
    if (classification.failures.length > 1) continue
    const bucket =
      classification.failures.length === 1
        ? `boundary:${classification.failures[0]}`
        : classification.unknown.length
          ? 'unknown'
          : 'compatible'
    const group = buckets.get(bucket) ?? []
    group.push(row)
    buckets.set(bucket, group)
  }
  const order = rows.filter((row) => governing.has(row.key))
  // Round robin reserves representation across failure dimensions and unknowns under overflow.
  const groups = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) =>
      group.sort(
        (a, b) =>
          softFacetPriority(b.softFacets, params.constraints) -
            softFacetPriority(a.softFacets, params.constraints) || a.key.localeCompare(b.key),
      ),
    )
  for (let offset = 0; groups.some((group) => offset < group.length); offset++)
    for (const group of groups) if (group[offset]) order.push(group[offset]!)
  const selectedKeys: string[] = []
  const omittedKeys = params.governingKeys.filter((key) => !rows.some((row) => row.key === key))
  let usedChars = params.alreadyUsedChars ?? 0
  for (const row of order) {
    if (!Number.isFinite(row.chars) || row.chars < 0 || usedChars + row.chars > params.maxChars)
      omittedKeys.push(row.key)
    else {
      selectedKeys.push(row.key)
      usedChars += row.chars
    }
  }
  return {
    selectedKeys,
    requiredKeys: [...new Set([...params.governingKeys, ...order.map((row) => row.key)])],
    governingKeys: [...new Set(params.governingKeys)],
    omittedKeys,
    selectionComplete: omittedKeys.length === 0,
    usedChars,
  }
}

/** Must be called after ALL hydration, identity, source and rendering caps, using actual prompt IDs. */
export function facetCoverage(params: {
  selection: FacetSelection
  finalPromptKeys: ReadonlySet<string>
  freshCompleteAuthorizedIndex: boolean
  hydrationVersionConsistent: boolean
}): { complete: boolean; promptRule: string } {
  const governingComplete = params.selection.governingKeys.every((key) =>
    params.finalPromptKeys.has(key),
  )
  const complete =
    params.freshCompleteAuthorizedIndex &&
    params.hydrationVersionConsistent &&
    params.selection.selectionComplete &&
    params.selection.requiredKeys.every((key) => params.finalPromptKeys.has(key))
  return {
    complete,
    promptRule: !governingComplete
      ? 'Governing policy source coverage is incomplete. Do not decide eligibility or present examples as qualifying. State that the available information is insufficient and direct the guest to staff.'
      : complete
        ? 'Selected guide-record collection coverage is complete. Decide all conditions only from full source bodies; this does not establish an exhaustive real-world offering inventory.'
        : 'Guide-record collection coverage is partial. Describe supported results as examples or a partial list. Do not claim all matches, none, a total eligible count, or infer eligibility from selector counts.',
  }
}

/** Prompt-internal record-statement counts, NEVER guest-facing facts or eligible-offering counts. */
export function recognizedStatementCountLines(params: {
  records: readonly FacetRecord[]
  freshCompleteAuthorizedIndex: boolean
  hydrationVersionConsistent: boolean
}): string[] {
  if (!params.freshCompleteAuthorizedIndex || !params.hydrationVersionConsistent) return []
  const rows = [...new Map(params.records.map((row) => [row.key, row])).values()]
  return [
    'Internal selection diagnostics only: counts describe recognized explicit statements in records, not eligible offerings or exhaustive parser recall. Never present these counts to guests.',
    ...FACET_KEYS.map(
      (key) =>
        `Records with recognized explicit ${key} statement: ${rows.filter((row) => row.facets[key] !== null).length}`,
    ),
  ]
}

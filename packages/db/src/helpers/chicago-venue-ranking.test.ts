import { describe, expect, it } from 'vitest'
import {
  CHICAGO_FIT_KEYS,
  CHICAGO_RANKING_VERSION,
  compareChicagoRankingVersions,
  compareChicagoVenueRankings,
  rankChicagoVenue,
  type ChicagoRankingInput,
  type RankingObservation,
} from './chicago-venue-ranking'

const source = 'https://venue.example.org/visit'
const base: ChicagoRankingInput = { venueId: 'venue-a', asOf: '2026-09-22', territory: 'Chicago Metro' }
const observed = (value: number): RankingObservation => ({ value, reason: 'A published visitor guide supports this assessment.', sourceUrls: [source], researchedAt: '2026-09-01', basis: 'verified' })
const fullFit = (value: number) => Object.fromEntries(CHICAGO_FIT_KEYS.map((key) => [key, observed(value)]))
const contact = { kind: 'email' as const, verified: true, suppressed: false, roleRelevant: true, sourceUrls: [source], researchedAt: '2026-09-01' }

describe('Chicago whole-market ranking v1.2', () => {
  it('keeps strong-fit venues without an email above weak-fit email-ready venues', () => {
    const strong = rankChicagoVenue({ ...base, fit: fullFit(95) })
    const weak = rankChicagoVenue({ ...base, venueId: 'venue-b', fit: fullFit(20), contacts: [contact] })
    expect(strong.productFit.value).toBe(95)
    expect(strong.contactability.value).toBeNull()
    expect(weak.contactability.value).toBeGreaterThan(0)
    expect([weak, strong].sort(compareChicagoVenueRankings).map((entry) => entry.venueId)).toEqual(['venue-a', 'venue-b'])
    expect(rankChicagoVenue({ ...base, fit: fullFit(95), contacts: [contact] }).productFit).toEqual(strong.productFit)
  })

  it('keeps absent observations null and explicitly needs research, never a fabricated zero', () => {
    const value = rankChicagoVenue(base)
    expect(value.state).toBe('needs-research')
    expect(value.productFit.value).toBeNull()
    expect(value.attainability.value).toBeNull()
    expect(value.contactability.value).toBeNull()
    expect(value.evidenceQuality.value).toBeNull()
    expect(value.evidenceFreshness.value).toBeNull()
    expect(value.researchPriority.value).toBe(100)
    expect(value.productFit.components.every((part) => part.value === null)).toBe(true)
    expect(value.researchGaps.some((gap) => gap.key === 'pilotScope')).toBe(true)
  })

  it('labels taxonomy prior as provisional, with five unknown product dimensions', () => {
    const value = rankChicagoVenue({ ...base, venueType: 'History museum' })
    expect(value.state).toBe('provisional-heuristic')
    expect(value.productFit.value).toBe(80)
    expect(value.productFit.coverage).toBe(0.17)
    expect(value.productFit.components.filter((part) => part.value === null)).toHaveLength(5)
    expect(value.productFit.components[5]?.sourceUrls).toEqual([])
    expect(value.researchGaps.find((gap) => gap.key === 'guideUseCases')?.priority).toBe(95)
  })

  it.each([
    'notamuseum', 'parkour', 'farmhousehold', 'museum or hotel', 'not a museum', 'museum?',
    'unknown museum', 'event venue museum ' + 'unverified detail '.repeat(20),
    'museum\nwebsite research notes', 'museum '.repeat(13),
  ])('refuses corrupted, ambiguous and substring-gaming categories: %s', venueType => {
    const input = { ...base, venueType }
    const before = JSON.stringify(input)
    const result = rankChicagoVenue(input)
    expect(result.productFit.value).toBeNull()
    expect(result.productFit.components.every(part => part.value === null)).toBe(true)
    expect(result.state).toBe('needs-research')
    expect(result.researchGaps.some(gap => gap.key === 'venueType')).toBe(true)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('recognizes bounded complete category tokens and preserves explicit evidence independently', () => {
    for (const venueType of ['local_history_museum', 'Botanical garden', 'historical society', 'Museums', 'museum/historic_site']) {
      expect(rankChicagoVenue({ ...base, venueType }).productFit.value).toBe(80)
    }
    expect(rankChicagoVenue({ ...base, venueType: 'museum'.padStart(120, ' ') }).productFit.value).toBe(80)
    expect(rankChicagoVenue({ ...base, venueType: 'museum'.padStart(121, ' ') }).productFit.value).toBeNull()
    const supported = rankChicagoVenue({ ...base, venueType: 'museum '.repeat(100), fit: fullFit(90) })
    expect(supported.productFit.value).toBe(90)
    expect(supported.researchGaps.find(gap => gap.key === 'venueType')?.reason).toContain('120')
  })

  it('compares a retained 1.0.0 category snapshot with current rules without rewriting history', () => {
    // Historical score projection: the old substring rule assigned an 80 museum prior.
    const before = { ...rankChicagoVenue({ ...base, venueType: 'museum' }), version: 'chicago-venue-ranking/1.0.0' }
    const beforeJson = JSON.stringify(before)
    const after = rankChicagoVenue({ ...base, venueType: 'museum '.repeat(200) })
    expect(after.version).toBe(CHICAGO_RANKING_VERSION)
    const comparison = compareChicagoRankingVersions(before, after)
    expect(comparison.beforeVersion).toBe('chicago-venue-ranking/1.0.0')
    expect(comparison.afterVersion).toBe(CHICAGO_RANKING_VERSION)
    expect(comparison.dimensions.productFit).toEqual({ before: 80, after: null, delta: null })
    expect(comparison.stateChanged).toBe(true)
    expect(JSON.stringify(before)).toBe(beforeJson)
  })

  it('averages only known component values and preserves actual zero evidence', () => {
    const value = rankChicagoVenue({ ...base, fit: { knowledgeRichness: observed(0), interpretiveValue: observed(80) } })
    expect(value.productFit.value).toBe(40)
    expect(value.productFit.coverage).toBe(0.33)
    expect(value.productFit.components[0]?.value).toBe(0)
    expect(value.state).toBe('provisional-heuristic')
  })

  it('requires supported, dated, complete, current fit observations for evidence-backed state', () => {
    expect(rankChicagoVenue({ ...base, fit: fullFit(80) }).state).toBe('evidence-backed')
    expect(rankChicagoVenue({ ...base, fit: fullFit(80), conflicts: ['Location identity disagrees'] }).state).toBe('provisional-heuristic')
    expect(rankChicagoVenue({ ...base, fit: { ...fullFit(80), guideUseCases: { ...observed(80), researchedAt: null } } }).state).toBe('provisional-heuristic')
    expect(rankChicagoVenue({ ...base, fit: { ...fullFit(80), guideUseCases: { ...observed(80), researchedAt: '2025-01-01' } } }).state).toBe('provisional-heuristic')
    expect(rankChicagoVenue({ ...base, fit: { knowledgeRichness: { ...observed(80), sourceUrls: [] } } }).productFit.value).toBeNull()
  })

  it('does not count unverified or suppressed email claims as usable routes', () => {
    expect(rankChicagoVenue({ ...base, contacts: [{ ...contact, verified: false }] }).contactability.value).toBeNull()
    const value = rankChicagoVenue({ ...base, contacts: [{ ...contact, suppressed: true }] })
    expect(value.contactability.value).toBe(0)
    expect(value.productFit.value).toBeNull()
    expect(value.contactability.reasons[0]).toContain('suppressed')
  })

  it('uses the best route without gaming the score by adding copies or weak routes', () => {
    const one = rankChicagoVenue({ ...base, contacts: [contact] }).contactability.value
    expect(rankChicagoVenue({ ...base, contacts: [contact, contact] }).contactability.value).toBe(one)
    expect(rankChicagoVenue({ ...base, contacts: [contact, { ...contact, kind: 'website', roleRelevant: false }] }).contactability.value).toBe(one)
  })

  it('calculates evidence and freshness independently and treats invalid dates as unknown', () => {
    const value = rankChicagoVenue({ ...base, sources: [
      { url: source, firstParty: true, researchedAt: '2026-09-01' },
      { url: 'https://operator.example.org', firstParty: false, researchedAt: '2025-01-01' },
    ] })
    expect(value.evidenceQuality.value).toBe(70)
    expect(value.evidenceFreshness.value).toBe(55)
    for (const researchedAt of ['2027-01-01', '2026-02-31', 'yesterday', null]) {
      expect(rankChicagoVenue({ ...base, sources: [{ url: source, firstParty: null, researchedAt }] }).evidenceFreshness.value).toBeNull()
    }
  })

  it('marks source conflicts as research priority without erasing underlying component scores', () => {
    const value = rankChicagoVenue({ ...base, fit: fullFit(90), sources: [{ url: source, firstParty: true, conflicted: true }] })
    expect(value.researchPriority.value).toBe(100)
    expect(value.state).toBe('provisional-heuristic')
    expect(value.productFit.value).toBe(90)
    expect(value.evidenceQuality.value).toBe(0)
  })

  it('counts each canonical source page once so repeated fresh evidence cannot hide a stale page', () => {
    const old = { url: 'https://venue.example.org/history', firstParty: false, researchedAt: '2024-01-01' }
    const recent = { url: source, firstParty: true, researchedAt: '2026-09-01' }
    const before = rankChicagoVenue({ ...base, sources: [old, recent] })
    const raw = [old, recent, { ...recent, url: 'https://VENUE.example.org:443/visit#top' }, recent, recent]
    const preserved = JSON.stringify(raw)
    const repeated = rankChicagoVenue({ ...base, sources: raw })
    expect(repeated).toEqual(before)
    expect(repeated.evidenceFreshness.value).toBe(55)
    expect(repeated.evidenceQuality.value).toBe(70)
    expect(repeated.researchGaps.some(gap => gap.key === 'evidenceFreshness')).toBe(true)
    expect(JSON.stringify(raw)).toBe(preserved)
  })

  it('uses the latest valid nonfuture source observation independent of insertion order', () => {
    const sources = [
      { url: source, firstParty: false, researchedAt: '2024-01-01' },
      { url: source, firstParty: true, researchedAt: '2026-09-01' },
      { url: source, firstParty: false, researchedAt: '2026-12-01' },
      { url: source, firstParty: false, researchedAt: '2026-02-31' },
    ]
    const result = rankChicagoVenue({ ...base, sources })
    expect(result).toEqual(rankChicagoVenue({ ...base, sources: [...sources].reverse() }))
    expect(result.evidenceFreshness.value).toBe(100)
    expect(result.evidenceQuality.value).toBe(100)
    expect(result.evidenceFreshness.components).toHaveLength(1)
  })

  it('keeps tied ownership unknown and unresolved source conflicts visible despite repetition', () => {
    const dated = { url: source, firstParty: true, researchedAt: '2026-09-01' }
    const disputed = { ...dated, firstParty: false }
    const result = rankChicagoVenue({ ...base, sources: [dated, disputed, dated, dated] })
    expect(result.evidenceQuality.value).toBeNull()
    expect(result.evidenceFreshness.value).toBe(100)
    const conflicted = rankChicagoVenue({ ...base, sources: [{ ...dated, researchedAt: '2024-01-01', conflicted: true }, dated] })
    expect(conflicted.evidenceQuality.value).toBe(0)
    expect(conflicted.researchPriority.value).toBe(100)
    const undated = rankChicagoVenue({ ...base, sources: [{ url: source, firstParty: true }, { url: source, firstParty: true, researchedAt: 'invalid' }] })
    expect(undated.evidenceFreshness.value).toBeNull()
    expect(undated.evidenceQuality.components).toHaveLength(1)
  })

  it('retains distinct paths and queries as distinct source pages', () => {
    const result = rankChicagoVenue({ ...base, sources: [
      { url: `${source}?language=en`, firstParty: true, researchedAt: '2026-09-01' },
      { url: `${source}?language=es`, firstParty: true, researchedAt: '2024-01-01' },
      { url: `${source}/hours`, firstParty: true, researchedAt: '2024-01-01' },
    ] })
    expect(result.evidenceFreshness.components).toHaveLength(3)
    expect(result.evidenceFreshness.value).toBe(40)
  })

  it('repeated contact routes cannot improve contactability or reduce research priority', () => {
    const single = rankChicagoVenue({ ...base, contacts: [contact] })
    const repeated = rankChicagoVenue({ ...base, contacts: Array.from({ length: 50 }, () => ({ ...contact })) })
    expect(repeated.contactability.value).toBe(single.contactability.value)
    expect(repeated.contactability.coverage).toBe(single.contactability.coverage)
    expect(repeated.researchPriority).toEqual(single.researchPriority)
    expect(repeated.completeness).toEqual(single.completeness)
    expect(repeated.rankKey).toEqual(single.rankKey)
  })

  it('compares retained 1.1.0 repeated-source scores against 1.2.0 without relabeling history', () => {
    const result = rankChicagoVenue({ ...base, sources: [
      { url: source, firstParty: true, researchedAt: '2026-09-01' },
      { url: `${source}/old`, firstParty: false, researchedAt: '2024-01-01' },
    ] })
    const prior = { ...result, version: 'chicago-venue-ranking/1.1.0', evidenceFreshness: { ...result.evidenceFreshness, value: 77.5 } }
    const preserved = JSON.stringify(prior)
    const diff = compareChicagoRankingVersions(prior, result)
    expect(diff.beforeVersion).toBe('chicago-venue-ranking/1.1.0')
    expect(diff.afterVersion).toBe('chicago-venue-ranking/1.2.0')
    expect(diff.dimensions.evidenceFreshness).toEqual({ before: 77.5, after: 55, delta: -22.5 })
    expect(JSON.stringify(prior)).toBe(preserved)
  })

  it('supports explicit unranked/excluded states, with exclusions taking priority over overrides', () => {
    const outside = rankChicagoVenue({ ...base, territory: 'Milwaukee', fit: fullFit(100) })
    const intentionally = rankChicagoVenue({ ...base, intentionallyUnrankedReason: 'Awaiting identity review', fit: fullFit(100) })
    const archived = rankChicagoVenue({ ...base, archived: true })
    expect(outside.state).toBe('excluded')
    expect(intentionally.state).toBe('intentionally-unranked')
    expect(archived.stateReason).toBe('Archived venue.')
    expect(outside.rankKey).toEqual([null, null, null, null])
    expect(compareChicagoVenueRankings(rankChicagoVenue(base), outside)).toBeLessThan(0)
  })

  it('retains actor/date/rationale and computed evidence when a human overrides a dimension', () => {
    const override = { actor: 'tom', at: '2026-09-22T10:00:00Z', rationale: 'Current founder relationship assessment.', dimension: 'productFit' as const, value: 75 }
    const value = rankChicagoVenue({ ...base, fit: fullFit(30), override })
    expect(value.productFit.value).toBe(75)
    expect(value.productFit.components[0]?.value).toBe(30)
    expect(value.override).toEqual(override)
    expect(value.uncertainty).toContain('Human override is a decision, not new research evidence.')
    expect(() => rankChicagoVenue({ ...base, override: { ...override, actor: '' } })).toThrow(/Override/)
    expect(() => rankChicagoVenue({ ...base, override: { ...override, at: '2027-01-01' } })).toThrow(/Override/)
  })

  it('requires explicit date and stable identity, and rejects invalid scoring evidence', () => {
    expect(() => rankChicagoVenue({ ...base, asOf: '2026-02-31' })).toThrow(/asOf/)
    expect(() => rankChicagoVenue({ ...base, venueId: '' })).toThrow(/venueId/)
    for (const value of [NaN, Infinity, -1, 101]) expect(rankChicagoVenue({ ...base, fit: { knowledgeRichness: observed(value) } }).productFit.value).toBeNull()
    expect(rankChicagoVenue({ ...base, fit: { knowledgeRichness: { ...observed(80), sourceUrls: ['javascript:alert(1)'] } } }).productFit.value).toBeNull()
  })

  it('is reproducible, stable under sorting ties, and compares retained version snapshots', () => {
    const input = { ...base, fit: fullFit(80) }
    const before = rankChicagoVenue(input)
    expect(before).toEqual(rankChicagoVenue(JSON.parse(JSON.stringify(input))))
    expect(before.version).toBe(CHICAGO_RANKING_VERSION)
    const prior = { ...before, version: 'historical/0.1' }
    const after = rankChicagoVenue({ ...base, fit: fullFit(90) })
    const diff = compareChicagoRankingVersions(prior, after)
    expect(diff.beforeVersion).toBe('historical/0.1')
    expect(diff.afterVersion).toBe(CHICAGO_RANKING_VERSION)
    expect(diff.dimensions.productFit).toEqual({ before: 80, after: 90, delta: 10 })
    expect(diff.dimensions.attainability?.delta).toBeNull()
    expect(compareChicagoVenueRankings(before, { ...before, venueId: 'venue-b' })).toBe(-1)
    expect(() => compareChicagoRankingVersions(before, { ...after, venueId: 'another' })).toThrow(/same venue/)
  })
})

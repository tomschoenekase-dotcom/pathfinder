import { describe, it, expect } from 'vitest'
import {
  countyResearchOwner,
  researchTerritory,
  validateProspectTerritoryRegistry,
  PROSPECT_TERRITORY_REGISTRY,
  planProspectGeography,
  CHICAGO_MILWAUKEE_RESEARCH_CODES,
  chicagoOperatingWhere,
  geographyHash,
} from './prospect-territory-registry'

const evidence = {
  venueId: 'native-1',
  countyGeoid: '17031',
  state: 'IL',
  countyVintage: '2025 Census Gazetteer',
  physicalAddress: '123 Example Avenue, Chicago, IL',
  anchorKind: 'PHYSICAL_STREET_ADDRESS',
  method: 'OFFICIAL_PHYSICAL_COUNTY',
  addressSourceUrl: 'https://example.org/visit',
  countySourceUrl: 'https://example.gov/property',
  addressQuote: '123 Example Avenue, Chicago, IL',
  countyQuote: 'Fixture only: this physical location is in Cook County.',
  observedAt: '2026-09-22',
  sourceResultHash: 'a'.repeat(64),
  uncertain: false,
  conflicting: false,
}
const plan = (patch: Record<string, unknown> = {}) =>
  planProspectGeography({
    venueId: 'native-1',
    state: 'IL',
    asOf: '2026-09-22',
    evidence: { ...evidence, ...patch },
  })
describe('approved county partition', () => {
  it('covers the complete frozen universe once', () =>
    expect(validateProspectTerritoryRegistry()).toMatchObject({
      territories: 476,
      counties: 3109,
      jurisdictions: 49,
    }))
  it.each(PROSPECT_TERRITORY_REGISTRY.territories)('$code resolves all of its counties', (t) => {
    for (const g of t.countyGeoids) expect(countyResearchOwner(g)?.territoryCode).toBe(t.code)
  })
  it('keeps Evanston/Cook, Lake IL, Lake IN, Kenosha and Milwaukee separate', () => {
    expect(
      ['17031', '17097', '18089', '55059', '55079'].map(
        (g) => countyResearchOwner(g)?.territoryCode,
      ),
    ).toEqual([
      'TR-IL-COOK',
      'TR-IL-LAKE',
      'TR-IN-DUNES',
      'TR-WI-RACINE-KENOSHA',
      'TR-WI-MILWAUKEE',
    ])
  })
  it('supports current CT equivalents and independent cities', () => {
    expect(countyResearchOwner('09110')).not.toBeNull()
    expect(countyResearchOwner('09001')).toBeNull()
    expect(countyResearchOwner('29510')).not.toBeNull()
    expect(countyResearchOwner('11001')).not.toBeNull()
  })
  it.each(['AK', '02020', '15003', '17031 ', '1703', 17031])(
    'refuses out of scope or malformed county %s',
    (g) => expect(countyResearchOwner(g as string)).toBeNull(),
  )
  it('contains only pinned corridor leaves', () => {
    expect(CHICAGO_MILWAUKEE_RESEARCH_CODES).toHaveLength(18)
    for (const code of CHICAGO_MILWAUKEE_RESEARCH_CODES)
      expect(researchTerritory(code)).not.toBeNull()
  })
  it('cannot mutate loaded geography', () =>
    expect(() => {
      const county = (PROSPECT_TERRITORY_REGISTRY.counties as { geoid: string }[])[0]!
      county.geoid = '99999'
    }).toThrow())
  it('hashes independent of object key order', () =>
    expect(geographyHash({ a: 1, b: 2 })).toBe(geographyHash({ b: 2, a: 1 })))
})
describe('physical geography admission', () => {
  it('retains native ID and computes rather than accepts territory', () =>
    expect(plan()).toMatchObject({
      status: 'ASSIGNED',
      venueId: 'native-1',
      territoryCode: 'TR-IL-COOK',
    }))
  it.each([
    { venueId: 'another' },
    { countyGeoid: '18089' },
    { observedAt: '2026-09-23' },
    { observedAt: '2026-02-30' },
    { countyVintage: '2020' },
    { uncertain: true },
    { conflicting: true },
    { physicalAddress: 'PO Box 123 Chicago IL' },
    { method: 'CITY_ONLY' },
    { territoryCode: 'TR-WI-MILWAUKEE' },
    { addressSourceUrl: 'http://127.0.0.1' },
    { countySourceUrl: 'https://example.org@localhost' },
  ])('holds unsafe input %j', (patch) => expect(plan(patch)).toMatchObject({ status: 'GEO_HOLD' }))
  it('holds missing evidence', () =>
    expect(
      planProspectGeography({ venueId: 'v', state: 'IL', asOf: '2026-09-22', evidence: null }),
    ).toMatchObject({ status: 'GEO_HOLD' }))
  it('does not use geography as consent or deliverability', () => {
    const result = plan()
    expect(result).not.toHaveProperty('permissionState')
    expect(result).not.toHaveProperty('emailReadiness')
  })
  it('bridges Chicago legacy membership without defining Chicago by all IL/IN/WI', () =>
    expect(chicagoOperatingWhere()).toEqual({
      OR: [
        { territory: { name: 'Chicago Metro' } },
        { geography: { legacyTerritory: { name: 'Chicago Metro' } } },
      ],
    }))
})

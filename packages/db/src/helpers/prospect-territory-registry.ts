import { createHash } from 'node:crypto'
import { z } from 'zod'
import asset from '../data/prospect-territory-registry.v1.json'

export type ResearchTerritory = {
  code: string
  name: string
  kind: string
  states: readonly string[]
  countyGeoids: readonly string[]
}
export type ResearchCounty = { geoid: string; state: string; name: string; territoryCode: string }
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
          .join(',')}}`
      : (JSON.stringify(value) ?? 'null')
export const geographyHash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex')
const freeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export const PROSPECT_TERRITORY_REGISTRY = freeze(asset)
export const PROSPECT_GEOGRAPHY_VERSION = asset.version
export const PROSPECT_GEOGRAPHY_HASH = geographyHash({
  version: asset.version,
  countyVintage: asset.countyVintage,
  territories: asset.territories,
  counties: asset.counties,
})
export const PROSPECT_GEOGRAPHY_VINTAGE = asset.countyVintage
const counties = new Map<string, ResearchCounty>(asset.counties.map((c) => [c.geoid, c]))
const territories = new Map<string, ResearchTerritory>(asset.territories.map((t) => [t.code, t]))

export function countyResearchOwner(geoid: string): ResearchCounty | null {
  return /^\d{5}$/.test(geoid) ? (counties.get(geoid) ?? null) : null
}
export function researchTerritory(code: string): ResearchTerritory | null {
  return territories.get(code) ?? null
}
export function validateProspectTerritoryRegistry() {
  if (
    asset.territories.length !== 476 ||
    territories.size !== 476 ||
    asset.counties.length !== 3109 ||
    counties.size !== 3109
  )
    throw new Error('Pinned territory partition size/uniqueness mismatch')
  const covered = new Set<string>()
  for (const territory of asset.territories)
    for (const geoid of territory.countyGeoids) {
      const county = counties.get(geoid)
      if (
        !county ||
        covered.has(geoid) ||
        county.territoryCode !== territory.code ||
        !territory.states.includes(county.state)
      )
        throw new Error('County membership disagrees with the approved registry')
      covered.add(geoid)
    }
  const states = new Set(asset.counties.map((c) => c.state))
  if (
    covered.size !== 3109 ||
    states.size !== 49 ||
    states.has('AK') ||
    states.has('HI') ||
    !states.has('DC')
  )
    throw new Error('Contiguous-US universe mismatch')
  return {
    version: asset.version,
    registryHash: PROSPECT_GEOGRAPHY_HASH,
    territories: 476,
    counties: 3109,
    jurisdictions: 49,
  }
}

export const CHICAGO_MILWAUKEE_RESEARCH_CODES = Object.freeze([
  'TR-IL-COOK',
  'TR-IL-DUPAGE',
  'TR-IL-LAKE',
  'TR-IL-MCHENRY',
  'TR-IL-KANE-KENDALL',
  'TR-IL-WILL-GRUNDY',
  'TR-IL-ROCKFORD',
  'TR-IL-ROCK-RIVER',
  'TR-IL-GALENA',
  'TR-IN-DUNES',
  'TR-IN-KANKAKEE',
  'TR-WI-MILWAUKEE',
  'TR-WI-RACINE-KENOSHA',
  'TR-WI-WALWORTH-JEFFERSON',
  'TR-WI-MADISON',
  'TR-WI-ROCK-GREEN',
  'TR-WI-DODGE-FOND-DU-LAC',
  'TR-WI-LAKESHORE',
])

export const GeographyPublicUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      if (/[\s\\]/.test(value)) return false
      const u = new URL(value),
        h = u.hostname.toLowerCase().replace(/\.$/, '')
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        h.includes('.') &&
        !h.includes(':') &&
        !h.includes('[') &&
        !/^\d+(\.\d+)*$/.test(h) &&
        !/(^|\.)(localhost|local|internal|test|invalid|lan|home)$/.test(h)
      )
    } catch {
      return false
    }
  }, 'Public evidence URL required; fetching still requires DNS/redirect controls')
const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const stamp = Date.parse(`${v}T00:00:00Z`)
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === v
  })
export const ProspectPhysicalCountyEvidence = z
  .object({
    venueId: z.string().min(1).max(191),
    countyGeoid: z.string().regex(/^\d{5}$/),
    state: z.string().regex(/^[A-Z]{2}$/),
    countyVintage: z.literal('2025 Census Gazetteer'),
    physicalAddress: z.string().trim().min(10).max(1000),
    anchorKind: z.enum(['VISITOR_ENTRANCE', 'PHYSICAL_STREET_ADDRESS']),
    method: z.enum(['OFFICIAL_PHYSICAL_COUNTY', 'CENSUS_2025_ADDRESS_MATCH']),
    addressSourceUrl: GeographyPublicUrl,
    countySourceUrl: GeographyPublicUrl,
    addressQuote: z.string().trim().min(12).max(2000),
    countyQuote: z.string().trim().min(12).max(2000),
    observedAt: DateOnly,
    sourceResultHash: z.string().regex(/^[a-f0-9]{64}$/),
    uncertain: z.boolean(),
    conflicting: z.boolean(),
  })
  .strict()
export type PhysicalCountyEvidence = z.infer<typeof ProspectPhysicalCountyEvidence>
export function planProspectGeography(input: {
  venueId: string
  state: string | null
  evidence: unknown
  asOf: string
}) {
  const parsed = ProspectPhysicalCountyEvidence.safeParse(input.evidence)
  const hold = (reason: string) => ({
    status: 'GEO_HOLD' as const,
    reason,
    venueId: input.venueId,
    modelVersion: PROSPECT_GEOGRAPHY_VERSION,
  })
  if (!parsed.success)
    return hold(
      'Physical-county evidence is missing or invalid; city/ZIP/sheet labels are not geocodes.',
    )
  const e = parsed.data,
    county = countyResearchOwner(e.countyGeoid)
  if (!DateOnly.safeParse(input.asOf).success || e.observedAt > input.asOf)
    return hold('Observation date is invalid or in the future.')
  if (e.venueId !== input.venueId) return hold('Evidence belongs to a different native venue.')
  if (!county || county.state !== e.state || (input.state !== null && input.state !== e.state))
    return hold('County, state or registry vintage conflicts with physical-site identity.')
  if (e.uncertain || e.conflicting)
    return hold('Uncertain or conflicting physical geography requires review.')
  if (/\bP\.?\s*O\.?\s*Box\b|\bPost Office Box\b/i.test(e.physicalAddress))
    return hold('A postal box is not the physical visitor anchor.')
  return {
    status: 'ASSIGNED' as const,
    reason: 'Reviewed physical-site county evidence matches the locked county registry.',
    venueId: input.venueId,
    modelVersion: PROSPECT_GEOGRAPHY_VERSION,
    countyGeoid: county.geoid,
    territoryCode: county.territoryCode,
    evidence: e,
  }
}

/** Legacy operating membership is not canonical research ownership. No nationwide widening. */
export const chicagoOperatingWhere = () => ({
  OR: [
    { territory: { name: 'Chicago Metro' } },
    { geography: { legacyTerritory: { name: 'Chicago Metro' } } },
  ],
})

validateProspectTerritoryRegistry()

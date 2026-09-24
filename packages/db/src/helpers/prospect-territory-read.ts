import { db } from '../client'
import {
  PROSPECT_GEOGRAPHY_VERSION,
  PROSPECT_GEOGRAPHY_HASH,
  PROSPECT_TERRITORY_REGISTRY,
  CHICAGO_MILWAUKEE_RESEARCH_CODES,
  researchTerritory,
  chicagoOperatingWhere,
  ProspectPhysicalCountyEvidence,
} from './prospect-territory-registry'

export async function readProspectGeographySummary() {
  const model = await db.prospectGeographyModel.findUnique({
    where: { version: PROSPECT_GEOGRAPHY_VERSION },
  })
  if (!model)
    return {
      installed: false,
      version: PROSPECT_GEOGRAPHY_VERSION,
      registryHash: PROSPECT_GEOGRAPHY_HASH,
      territories: 0,
      counties: 0,
      assigned: 0,
      held: 0,
      notInitialized: 0,
      chicagoAssigned: 0,
      chicagoHeld: 0,
      nativeTotal: 0,
      importedLineageCount: 0,
      importedAssigned: 0,
      importedHeld: 0,
      importedUninitialized: 0,
      approvalAt: PROSPECT_TERRITORY_REGISTRY.approvalAt,
    }
  const version = { modelVersion: PROSPECT_GEOGRAPHY_VERSION }
  const active = { archivedAt: null, organization: { archivedAt: null } }
  const imported = {
    sources: { some: { sourceType: { in: ['WORKBOOK', 'STAGING_PACKAGE', 'IMPORT'] } } },
  }
  const [
    territories,
    counties,
    assigned,
    held,
    notInitialized,
    chicagoAssigned,
    chicagoHeld,
    nativeTotal,
    importedLineageCount,
    importedAssigned,
    importedHeld,
    importedUninitialized,
  ] = await Promise.all([
    db.prospectTerritoryDefinition.count({ where: version }),
    db.prospectCountyAssignment.count({ where: version }),
    db.prospectVenueGeography.count({ where: { ...version, status: 'ASSIGNED', venue: active } }),
    db.prospectVenueGeography.count({
      where: { ...version, status: { not: 'ASSIGNED' }, venue: active },
    }),
    db.prospectVenue.count({ where: { geography: null, ...active, ...imported } }),
    db.prospectVenue.count({
      where: {
        AND: [chicagoOperatingWhere()],
        geography: { ...version, status: 'ASSIGNED' },
        ...active,
      },
    }),
    db.prospectVenue.count({
      where: {
        AND: [chicagoOperatingWhere()],
        geography: { ...version, status: { not: 'ASSIGNED' } },
        ...active,
      },
    }),
    db.prospectVenue.count(),
    db.prospectVenue.count({ where: imported }),
    db.prospectVenue.count({
      where: { ...imported, geography: { ...version, status: 'ASSIGNED' } },
    }),
    db.prospectVenue.count({
      where: { ...imported, geography: { ...version, status: { not: 'ASSIGNED' } } },
    }),
    db.prospectVenue.count({ where: { ...imported, geography: null } }),
  ])
  if (model.registryHash !== PROSPECT_GEOGRAPHY_HASH)
    throw new Error(
      'Installed registry differs from this release; read-only mismatch, no automatic mutation',
    )
  return {
    installed: true,
    version: model.version,
    registryHash: model.registryHash,
    countyVintage: model.countyVintage,
    territories,
    counties,
    assigned,
    held,
    notInitialized,
    chicagoAssigned,
    chicagoHeld,
    nativeTotal,
    importedLineageCount,
    importedAssigned,
    importedHeld,
    importedUninitialized,
    populationDefinitions: {
      nativeTotal: 'Every native venue, including archived and non-import records',
      imported:
        'Distinct native venues with retained WORKBOOK, STAGING_PACKAGE or IMPORT source evidence, including archived records',
      workspace:
        'Active native venues under active organizations, using this exact geography model',
    },
    approvalAt: model.approvedAt.toISOString(),
  }
}
export async function readResearchTerritories(
  input: {
    query?: string | undefined
    state?: string | undefined
    code?: string | undefined
    corridor?: boolean | undefined
    page: number
    limit: number
  },
  allowedTerritoryIds?: readonly string[],
) {
  const where = {
    modelVersion: PROSPECT_GEOGRAPHY_VERSION,
    ...(allowedTerritoryIds ? { territoryId: { in: [...allowedTerritoryIds] } } : {}),
    ...(input.code
      ? { code: input.code }
      : input.corridor
        ? { code: { in: [...CHICAGO_MILWAUKEE_RESEARCH_CODES] } }
        : {}),
    ...(input.state ? { counties: { some: { state: input.state } } } : {}),
    ...(input.query
      ? {
          OR: [
            { name: { contains: input.query, mode: 'insensitive' as const } },
            { code: { contains: input.query, mode: 'insensitive' as const } },
            { territoryId: { contains: input.query, mode: 'insensitive' as const } },
            {
              counties: {
                some: {
                  OR: [
                    { countyName: { contains: input.query, mode: 'insensitive' as const } },
                    { countyGeoid: { contains: input.query } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  }
  const [total, rows] = await Promise.all([
    db.prospectTerritoryDefinition.count({ where }),
    db.prospectTerritoryDefinition.findMany({
      where,
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      include: {
        counties: {
          orderBy: { countyGeoid: 'asc' },
          select: { countyGeoid: true, state: true, countyName: true },
        },
        territory: {
          select: {
            _count: {
              select: {
                venues: {
                  where: {
                    archivedAt: null,
                    organization: { archivedAt: null },
                    geography: { modelVersion: PROSPECT_GEOGRAPHY_VERSION, status: 'ASSIGNED' },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ])
  return {
    version: PROSPECT_GEOGRAPHY_VERSION,
    registryHash: PROSPECT_GEOGRAPHY_HASH,
    total,
    page: input.page,
    limit: input.limit,
    researchContract: {
      version: 'torchiko.territory-research/v1',
      ownership: 'Physical visitor site county only; never HQ, ZIP centroid or an old sheet label.',
      discoveryFields: [
        'native identity or review candidate',
        'venue name',
        'official site-specific URL',
        'physical location evidence',
        'county and model version',
        'category',
        'public contact route and exact source/date',
        'identity state',
      ],
      deferredUntilPreparation: [
        'current exhibit/event observations',
        'current staff role',
        'personalization',
        'availability and hours',
      ],
      duplication:
        'Search across existing identities before admission. A shared parent domain/email is not a duplicate. Distinct physical branches retain native IDs. A cross-border finding belongs to its physical county owner.',
      parallelism:
        'Acquire an exclusive whole-county lease from the pinned county owner; planned work cells record attempted coverage but do not create subcounty grants. Discovery findings require centralized global identity review. Do not launch when the lease, current transport or admission control is unavailable.',
      completion:
        'Track attempted county/town/category cells including zero-result and cap-reached outcomes; finding only famous attractions is not complete coverage.',
      score:
        'Reuse evidence-backed product-fit dimensions; unknown is not zero. Contactability and permission are separate.',
    },
    items: rows.map((t) => ({
      code: t.code,
      nativeTerritoryId: t.territoryId,
      name: t.name,
      kind: t.kind,
      states: t.states,
      counties: t.counties,
      assignedVenues: t.territory._count.venues,
      instruction:
        'Research only these physical counties. Geography does not establish company identity, contact permission or completeness.',
    })),
    hasMore: input.page * input.limit < total,
  }
}
export async function readProspectGeographyHolds(
  input: {
    query?: string | undefined
    status?: 'HELD' | 'ASSIGNED' | 'ALL' | undefined
    territoryCode?: string | undefined
    countyGeoid?: string | undefined
    legacyTerritoryId?: string | undefined
    state?: string | undefined
    page: number
    limit: number
  },
  allowedTerritoryIds?: readonly string[],
) {
  const where = {
    modelVersion: PROSPECT_GEOGRAPHY_VERSION,
    ...(input.status === 'ALL'
      ? {}
      : input.status === 'ASSIGNED'
        ? { status: 'ASSIGNED' }
        : { status: { not: 'ASSIGNED' } }),
    ...(input.legacyTerritoryId ? { legacyTerritoryId: input.legacyTerritoryId } : {}),
    ...(input.territoryCode ? { county: { territoryCode: input.territoryCode } } : {}),
    ...(input.countyGeoid ? { countyGeoid: input.countyGeoid } : {}),
    venue: {
      archivedAt: null,
      organization: { archivedAt: null },
      ...(input.state ? { region: input.state } : {}),
      ...(allowedTerritoryIds ? { territoryId: { in: [...allowedTerritoryIds] } } : {}),
      ...(input.query
        ? {
            OR: [
              { id: { contains: input.query, mode: 'insensitive' as const } },
              { name: { contains: input.query, mode: 'insensitive' as const } },
              { city: { contains: input.query, mode: 'insensitive' as const } },
              { addressLine1: { contains: input.query, mode: 'insensitive' as const } },
              { postalCode: { contains: input.query } },
              { normalizedDomain: { contains: input.query.toLowerCase() } },
            ],
          }
        : {}),
    },
  }
  const [total, items] = await Promise.all([
    db.prospectVenueGeography.count({ where }),
    db.prospectVenueGeography.findMany({
      where,
      orderBy: { venueId: 'asc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      select: {
        venueId: true,
        status: true,
        reason: true,
        revision: true,
        county: {
          select: { countyGeoid: true, countyName: true, state: true, territoryCode: true },
        },
        legacyTerritory: { select: { id: true, name: true } },
        venue: {
          select: {
            organizationId: true,
            name: true,
            city: true,
            region: true,
            website: true,
            updatedAt: true,
          },
        },
      },
    }),
  ])
  return {
    version: PROSPECT_GEOGRAPHY_VERSION,
    total,
    items,
    page: input.page,
    limit: input.limit,
    hasMore: input.page * input.limit < total,
  }
}
export async function readProspectPhysicalGeography(
  venueId: string,
  allowedTerritoryIds?: readonly string[],
) {
  // Scope and related geography are read together. Do not pre-authorize one
  // query and then fetch an unscoped sibling projection after ownership changes.
  const native = await db.prospectVenue.findFirst({
    where: {
      id: venueId,
      ...(allowedTerritoryIds ? { territoryId: { in: [...allowedTerritoryIds] } } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      name: true,
      website: true,
      city: true,
      region: true,
      addressLine1: true,
      addressLine2: true,
      postalCode: true,
      country: true,
      updatedAt: true,
      archivedAt: true,
      geography: {
        include: { county: true, legacyTerritory: { select: { id: true, name: true } } },
      },
    },
  })
  const row = native?.geography ?? null
  const venue = native ? (({ geography: _geography, ...fields }) => fields)(native) : null
  const evidence = ProspectPhysicalCountyEvidence.safeParse(row?.anchor)
  return {
    venueId,
    version: PROSPECT_GEOGRAPHY_VERSION,
    registryHash: PROSPECT_GEOGRAPHY_HASH,
    geography: row,
    physicalEvidence: evidence.success && evidence.data.venueId === venueId ? evidence.data : null,
    territory: row?.county ? researchTerritory(row.county.territoryCode) : null,
    venue,
  }
}

import type { Prisma } from '@prisma/client'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import {
  AssignProspectGeographyInput,
  InvalidateProspectGeographyInput,
} from './prospect-territory-contract'
export {
  AssignProspectGeographyInput,
  InvalidateProspectGeographyInput,
} from './prospect-territory-contract'
import { db } from '../client'
import {
  PROSPECT_GEOGRAPHY_VERSION,
  PROSPECT_GEOGRAPHY_HASH,
  PROSPECT_TERRITORY_REGISTRY,
  geographyHash,
  planProspectGeography,
  validateProspectTerritoryRegistry,
} from './prospect-territory-registry'

export type ProspectGeographyTransaction = Pick<
  typeof db,
  | 'prospectGeographyModel'
  | 'prospectTerritoryDefinition'
  | 'prospectCountyAssignment'
  | 'prospectVenueGeography'
  | 'prospectTerritory'
  | 'prospectVenue'
  | 'prospectSourceEvidence'
  | 'prospectIntelligenceReceipt'
  | 'auditLog'
>
type Tx = ProspectGeographyTransaction
export type GeographyActor = {
  id: string
  runId: string
  type: 'HUMAN' | 'AGENT' | 'SYSTEM'
  scope: { mode: 'ALL' } | { mode: 'TERRITORIES'; territoryIds: readonly string[] }
  capabilities: readonly string[]
}
export class ProspectGeographyError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectGeographyError'
  }
}
const json = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue
const obj = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const requireActor = (actor: GeographyActor, cap: string) => {
  if (!actor.id.trim() || !actor.runId.trim() || !actor.capabilities.includes(cap))
    throw new ProspectGeographyError('FORBIDDEN', `The current actor/run requires ${cap}`)
}
const scopeVenue = (actor: GeographyActor, territoryId: string | null) => {
  if (
    actor.scope.mode !== 'ALL' &&
    (!territoryId || !actor.scope.territoryIds.includes(territoryId))
  )
    throw new ProspectGeographyError(
      'FORBIDDEN',
      'Native venue is outside the current territory grant',
    )
}
async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      return await db.$transaction(work, {
        isolationLevel: 'Serializable',
        timeout: 30000,
        maxWait: 5000,
      })
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        ['P2034', 'P2002'].includes(error.code) &&
        attempt < 2
      )
        continue
      throw error
    }
  throw new ProspectGeographyError('CONFLICT', 'Concurrent geography update; reload current state')
}
async function installed(tx: Pick<Tx, 'prospectGeographyModel'>) {
  const model = await tx.prospectGeographyModel.findUnique({
    where: { version: PROSPECT_GEOGRAPHY_VERSION },
  })
  if (!model || model.registryHash !== PROSPECT_GEOGRAPHY_HASH)
    throw new ProspectGeographyError(
      'CONFLICT',
      'Approved geography model is not installed with the expected hash',
    )
  return model
}
async function audit(
  tx: Tx,
  actor: GeographyActor,
  action: string,
  targetId: string,
  before: unknown,
  after: unknown,
) {
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      actorType: actor.type,
      actorRole: actor.type === 'AGENT' ? 'AGENT' : 'PLATFORM_ADMIN',
      ...(actor.type === 'AGENT' ? { agentRunId: actor.runId } : {}),
      action,
      targetType: 'ProspectGeography',
      targetId,
      beforeState: json(before),
      afterState: json(after),
    },
  })
}

/** Installation is explicit. Loading a module or viewing the CRM never seeds a registry. */
export async function installProspectGeographyModel(actor: GeographyActor) {
  requireActor(actor, 'prospects.maintain')
  if (actor.scope.mode !== 'ALL' || actor.type === 'AGENT')
    throw new ProspectGeographyError(
      'FORBIDDEN',
      'Model installation requires a platform operator, not a territory research worker',
    )
  validateProspectTerritoryRegistry()
  return transaction(async (tx) => {
    const existing = await tx.prospectGeographyModel.findUnique({
      where: { version: PROSPECT_GEOGRAPHY_VERSION },
    })
    if (existing) {
      await installed(tx)
      const definitions = await tx.prospectTerritoryDefinition.count({
        where: { modelVersion: PROSPECT_GEOGRAPHY_VERSION },
      })
      const counties = await tx.prospectCountyAssignment.count({
        where: { modelVersion: PROSPECT_GEOGRAPHY_VERSION },
      })
      if (definitions !== 476 || counties !== 3109)
        throw new ProspectGeographyError(
          'CONFLICT',
          'Frozen registry is incomplete; do not silently repair a locked version',
        )
      return {
        replayed: true,
        version: PROSPECT_GEOGRAPHY_VERSION,
        registryHash: PROSPECT_GEOGRAPHY_HASH,
        territories: definitions,
        counties,
      }
    }
    const old = await tx.prospectTerritory.findMany({
      where: { code: { in: PROSPECT_TERRITORY_REGISTRY.territories.map((t) => t.code) } },
      select: { id: true, code: true, name: true, archivedAt: true },
    })
    const ids = new Map(old.map((t) => [t.code, t.id]))
    for (const entry of old) {
      const expected = PROSPECT_TERRITORY_REGISTRY.territories.find((t) => t.code === entry.code)
      if (entry.archivedAt || entry.name !== expected?.name)
        throw new ProspectGeographyError(
          'CONFLICT',
          'An existing territory code has a different owner or name',
        )
    }
    const fresh = PROSPECT_TERRITORY_REGISTRY.territories
      .filter((t) => !ids.has(t.code))
      .map((t) => {
        const id = `pterr_geo_${geographyHash(t.code).slice(0, 24)}`
        ids.set(t.code, id)
        return {
          id,
          code: t.code,
          name: t.name,
          region: t.states.join('/'),
          description: `County-defined research territory; ${PROSPECT_GEOGRAPHY_VERSION}. Not an outreach permission or legacy sheet.`,
          createdBy: actor.id,
          updatedBy: actor.id,
        }
      })
    if (fresh.length) await tx.prospectTerritory.createMany({ data: fresh })
    await tx.prospectGeographyModel.create({
      data: {
        version: PROSPECT_GEOGRAPHY_VERSION,
        registryHash: PROSPECT_GEOGRAPHY_HASH,
        countyVintage: PROSPECT_TERRITORY_REGISTRY.countyVintage,
        approvalReference: PROSPECT_TERRITORY_REGISTRY.approvalReference,
        approvedAt: new Date(PROSPECT_TERRITORY_REGISTRY.approvalAt),
        approvedBy: 'Tom Schoenekase',
        sourceManifest: json(PROSPECT_TERRITORY_REGISTRY.sourceHashes),
      },
    })
    await tx.prospectTerritoryDefinition.createMany({
      data: PROSPECT_TERRITORY_REGISTRY.territories.map((t) => ({
        modelVersion: PROSPECT_GEOGRAPHY_VERSION,
        code: t.code,
        territoryId: ids.get(t.code)!,
        name: t.name,
        kind: t.kind,
        states: json(t.states),
      })),
    })
    // Chunks stay below PostgreSQL's bind-parameter limit.
    for (let offset = 0; offset < PROSPECT_TERRITORY_REGISTRY.counties.length; offset += 500)
      await tx.prospectCountyAssignment.createMany({
        data: PROSPECT_TERRITORY_REGISTRY.counties
          .slice(offset, offset + 500)
          .map((c) => ({
            modelVersion: PROSPECT_GEOGRAPHY_VERSION,
            countyGeoid: c.geoid,
            territoryCode: c.territoryCode,
            territoryId: ids.get(c.territoryCode)!,
            state: c.state,
            countyName: c.name,
          })),
      })
    await audit(
      tx,
      actor,
      'prospect.geography.model-install',
      PROSPECT_GEOGRAPHY_VERSION,
      {},
      { registryHash: PROSPECT_GEOGRAPHY_HASH, territories: 476, counties: 3109 },
    )
    return {
      replayed: false,
      version: PROSPECT_GEOGRAPHY_VERSION,
      registryHash: PROSPECT_GEOGRAPHY_HASH,
      territories: 476,
      counties: 3109,
    }
  })
}

/** Bounded, restart-safe backfill: missing county stays explicitly held; originals never rewritten. */
export async function initializeProspectGeographyBatch(actor: GeographyActor) {
  requireActor(actor, 'prospects.maintain')
  if (actor.scope.mode !== 'ALL' || actor.type === 'AGENT')
    throw new ProspectGeographyError(
      'FORBIDDEN',
      'Legacy migration requires platform-wide operator authority',
    )
  return transaction(async (tx) => {
    await installed(tx)
    const rows = await tx.prospectVenue.findMany({
      where: {
        OR: [
          { sourceImportRowId: { not: null } },
          { sources: { some: { sourceType: { in: ['WORKBOOK', 'STAGING_PACKAGE', 'IMPORT'] } } } },
        ],
        geography: null,
      },
      orderBy: { id: 'asc' },
      take: 500,
      select: { id: true, territoryId: true, sourceImportRowId: true },
    })
    if (!rows.length) return { created: 0, venueIds: [] as string[], done: true }
    await tx.prospectVenueGeography.createMany({
      data: rows.map((v) => ({
        venueId: v.id,
        modelVersion: PROSPECT_GEOGRAPHY_VERSION,
        legacyTerritoryId: v.territoryId,
        status: 'GEO_HOLD',
        reason:
          'Legacy import retained. No reviewed physical-county evidence has been admitted; sheet, city and ZIP are not canonical county assignments.',
        anchor: json({ sourceImportRowId: v.sourceImportRowId }),
        createdBy: actor.id,
        updatedBy: actor.id,
      })),
    })
    await audit(
      tx,
      actor,
      'prospect.geography.legacy-hold-batch',
      PROSPECT_GEOGRAPHY_VERSION,
      {},
      { venueIds: rows.map((v) => v.id), created: rows.length, changedNativeVenues: 0 },
    )
    return { created: rows.length, venueIds: rows.map((v) => v.id), done: false }
  })
}

export async function assignProspectGeography(raw: unknown, actor: GeographyActor) {
  return transaction((tx) => assignProspectGeographyInTransaction(raw, actor, tx))
}

/** Shared atomic owner: a review decision and its assignment must commit together. */
export async function assignProspectGeographyInTransaction(
  raw: unknown,
  actor: GeographyActor,
  tx: Tx,
) {
  requireActor(actor, 'prospects.maintain')
  // Workers may collect/propose evidence; ownership-changing evidence admission remains operator-reviewed.
  if (actor.type === 'AGENT')
    throw new ProspectGeographyError(
      'FORBIDDEN',
      'A researcher cannot approve its own geographic claim',
    )
  const input = AssignProspectGeographyInput.parse(raw),
    inputHash = geographyHash(input)
  const receiptId = `geo_rx_${geographyHash({ actor: actor.id, run: actor.runId, key: input.idempotencyKey }).slice(0, 32)}`
  await installed(tx)
  const venue = await tx.prospectVenue.findUnique({
    where: { id: input.venueId },
    include: { geography: true },
  })
  if (!venue) throw new ProspectGeographyError('NOT_FOUND', 'Native venue not found')
  scopeVenue(actor, venue.territoryId)
  const prior = await tx.prospectIntelligenceReceipt.findUnique({ where: { id: receiptId } })
  if (prior) {
    if (prior.inputHash !== inputHash)
      throw new ProspectGeographyError('CONFLICT', 'Retry key is already bound to other evidence')
    return { receiptId, replayed: true, ...obj(prior.result) }
  }
  const plan = planProspectGeography({
    venueId: venue.id,
    state: venue.region,
    evidence: input.evidence,
    asOf: new Date().toISOString().slice(0, 10),
  })
  if (plan.status !== 'ASSIGNED') throw new ProspectGeographyError('BAD_REQUEST', plan.reason)
  if (venue.archivedAt)
    throw new ProspectGeographyError(
      'CONFLICT',
      'Archived site needs identity review before geography assignment',
    )
  if (
    venue.updatedAt.toISOString() !== input.expectedVenueUpdatedAt ||
    (venue.geography?.revision ?? 0) !== input.expectedRevision
  )
    throw new ProspectGeographyError(
      'CONFLICT',
      'Venue or geography changed; reload rather than overwrite',
    )
  const county = await tx.prospectCountyAssignment.findUnique({
    where: {
      modelVersion_countyGeoid: {
        modelVersion: PROSPECT_GEOGRAPHY_VERSION,
        countyGeoid: plan.countyGeoid,
      },
    },
  })
  if (!county || county.territoryCode !== plan.territoryCode)
    throw new ProspectGeographyError('CONFLICT', 'Pinned county bridge is unavailable')
  scopeVenue(actor, county.territoryId)
  const evidenceId = `geo_ev_${receiptId}`
  await tx.prospectSourceEvidence.create({
    data: {
      id: evidenceId,
      organizationId: venue.organizationId,
      venueId: venue.id,
      sourceType: 'PHYSICAL_COUNTY_VERIFICATION',
      sourceUrl: input.evidence.addressSourceUrl,
      sourceLabel: 'Reviewed physical visitor location and authoritative county match',
      capturedValue: json(input.evidence),
      researchedAt: new Date(input.evidence.observedAt),
      createdBy: actor.id,
    },
  })
  const before = {
    nativeTerritoryId: venue.territoryId,
    venueUpdatedAt: venue.updatedAt.toISOString(),
    geography: venue.geography,
  }
  const next = {
    countyGeoid: county.countyGeoid,
    territoryId: county.territoryId,
    status: 'ASSIGNED',
    reason: plan.reason,
    evidenceIds: json([evidenceId]),
    anchor: json(input.evidence),
    updatedBy: actor.id,
  }
  if (venue.geography) {
    const changed = await tx.prospectVenueGeography.updateMany({
      where: { venueId: venue.id, revision: input.expectedRevision },
      data: { ...next, revision: { increment: 1 } },
    })
    if (changed.count !== 1)
      throw new ProspectGeographyError('CONFLICT', 'Concurrent geography change')
  } else
    await tx.prospectVenueGeography.create({
      data: {
        venueId: venue.id,
        modelVersion: PROSPECT_GEOGRAPHY_VERSION,
        legacyTerritoryId: venue.territoryId,
        createdBy: actor.id,
        ...next,
      },
    })
  const changed = await tx.prospectVenue.updateMany({
    where: { id: venue.id, updatedAt: new Date(input.expectedVenueUpdatedAt) },
    data: { territoryId: county.territoryId, updatedBy: actor.id },
  })
  if (changed.count !== 1) throw new ProspectGeographyError('CONFLICT', 'Concurrent venue change')
  const result = {
    venueId: venue.id,
    organizationId: venue.organizationId,
    territoryId: county.territoryId,
    territoryCode: county.territoryCode,
    countyGeoid: county.countyGeoid,
    modelVersion: PROSPECT_GEOGRAPHY_VERSION,
    revision: input.expectedRevision + 1,
    evidenceId,
    status: 'ASSIGNED',
    outreachAuthorized: false,
  }
  await tx.prospectIntelligenceReceipt.create({
    data: {
      id: receiptId,
      actorId: actor.id,
      actorType: actor.type,
      runId: actor.runId,
      idempotencyKey: input.idempotencyKey,
      operation: 'geography-assign',
      inputHash,
      venueId: venue.id,
      beforeState: json(before),
      afterState: json(result),
      result: json(result),
    },
  })
  await audit(tx, actor, 'prospect.geography.assign', venue.id, before, result)
  return { receiptId, replayed: false, ...result }
}

/** Re-open a mistaken/stale county claim without deleting evidence or overwriting the original sheet. */
export async function invalidateProspectGeography(raw: unknown, actor: GeographyActor) {
  requireActor(actor, 'prospects.maintain')
  if (actor.type === 'AGENT')
    throw new ProspectGeographyError(
      'FORBIDDEN',
      'A researcher may propose but cannot self-approve an ownership change',
    )
  const input = InvalidateProspectGeographyInput.parse(raw),
    inputHash = geographyHash(input)
  const receiptId = `geo_rx_${geographyHash({ actor: actor.id, run: actor.runId, key: input.idempotencyKey }).slice(0, 32)}`
  return transaction(async (tx) => {
    await installed(tx)
    const venue = await tx.prospectVenue.findUnique({
      where: { id: input.venueId },
      include: { geography: true },
    })
    if (!venue) throw new ProspectGeographyError('NOT_FOUND', 'Native venue not found')
    scopeVenue(actor, venue.territoryId)
    const previous = await tx.prospectIntelligenceReceipt.findUnique({ where: { id: receiptId } })
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new ProspectGeographyError('CONFLICT', 'Retry key has a different payload')
      return { receiptId, replayed: true, ...obj(previous.result) }
    }
    const geo = venue.geography
    if (
      !geo ||
      geo.status !== 'ASSIGNED' ||
      geo.revision !== input.expectedRevision ||
      venue.updatedAt.toISOString() !== input.expectedVenueUpdatedAt
    )
      throw new ProspectGeographyError(
        'CONFLICT',
        'Geography is no longer the selected assigned revision',
      )
    scopeVenue(actor, geo.legacyTerritoryId)
    const before = {
      nativeTerritoryId: venue.territoryId,
      venueUpdatedAt: venue.updatedAt.toISOString(),
      geography: geo,
    }
    const changed = await tx.prospectVenueGeography.updateMany({
      where: { venueId: venue.id, revision: input.expectedRevision, status: 'ASSIGNED' },
      data: {
        status: 'GEO_HOLD',
        countyGeoid: null,
        territoryId: null,
        reason: input.reason,
        revision: { increment: 1 },
        updatedBy: actor.id,
      },
    })
    if (changed.count !== 1)
      throw new ProspectGeographyError('CONFLICT', 'Concurrent geography correction')
    const native = await tx.prospectVenue.updateMany({
      where: { id: venue.id, updatedAt: new Date(input.expectedVenueUpdatedAt) },
      data: { territoryId: geo.legacyTerritoryId, updatedBy: actor.id },
    })
    if (native.count !== 1)
      throw new ProspectGeographyError('CONFLICT', 'Concurrent native venue change')
    const result = {
      venueId: venue.id,
      status: 'GEO_HOLD',
      revision: input.expectedRevision + 1,
      reason: input.reason,
      priorEvidencePreserved: true,
      nativeTerritoryId: geo.legacyTerritoryId,
      modelVersion: geo.modelVersion,
      outreachAuthorized: false,
    }
    await tx.prospectIntelligenceReceipt.create({
      data: {
        id: receiptId,
        actorId: actor.id,
        actorType: actor.type,
        runId: actor.runId,
        idempotencyKey: input.idempotencyKey,
        operation: 'geography-invalidate',
        inputHash,
        venueId: venue.id,
        beforeState: json(before),
        afterState: json(result),
        result: json(result),
      },
    })
    await audit(tx, actor, 'prospect.geography.invalidate', venue.id, before, result)
    return { receiptId, replayed: false, ...result }
  })
}

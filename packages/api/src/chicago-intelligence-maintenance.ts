import { CHICAGO_RANKING_VERSION, type ChicagoRankingInput } from '@pathfinder/db'
import {
  ChicagoIntelligenceError,
  intelligenceJson,
  intelligenceMutation,
  saveChicagoRanking,
  scopedVenue,
  type ChicagoActor,
  type ChicagoTransaction,
} from './chicago-intelligence-service'
import {
  chicagoLifecycleInput,
  chicagoRankingOverrideInput,
  chicagoRankingRefreshInput,
} from './chicago-intelligence-maintenance-contract'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
type Venue = Awaited<ReturnType<typeof scopedVenue>>
function requireMaintenance(actor: ChicagoActor) {
  if (!actor.id || !actor.runId || !actor.capabilities.includes('prospects.maintain')) {
    throw new ChicagoIntelligenceError(
      'FORBIDDEN',
      'Maintenance requires actor/run identity and a separately granted prospects.maintain capability',
    )
  }
}
function requireProfile(venue: Venue, expectedVersion: number) {
  if (!venue.intelligence || venue.intelligence.revision !== expectedVersion) {
    throw new ChicagoIntelligenceError(
      'CONFLICT',
      `Venue ${venue.id} changed; current revision ${venue.intelligence?.revision ?? 0}. Read current state before maintenance.`,
    )
  }
  return venue.intelligence
}
async function advance(tx: ChicagoTransaction, venueId: string, expectedVersion: number) {
  const changed = await tx.prospectVenueIntelligence.updateMany({
    where: { venueId, revision: expectedVersion },
    data: { revision: { increment: 1 } },
  })
  if (changed.count !== 1)
    throw new ChicagoIntelligenceError(
      'CONFLICT',
      'Concurrent venue maintenance; no correction was applied',
    )
}
function currentInput(venue: Venue, asOf: string): ChicagoRankingInput {
  const stored = object(venue.intelligence?.rankingInput) as Partial<ChicagoRankingInput>
  return {
    ...stored,
    venueId: venue.id,
    territory: 'Chicago Metro',
    asOf,
    venueType: venue.venueType,
    archived: Boolean(venue.archivedAt || venue.organization.archivedAt),
    conflicts: venue.intelligenceReviews.map((review) => review.reason),
  }
}
async function retainRanking(tx: ChicagoTransaction, venue: Venue, input: ChicagoRankingInput) {
  const suppressed = venue.contacts.some(
    (contact) =>
      !contact.archivedAt &&
      (contact.doNotContact ||
        contact.suppressedAt ||
        contact.unsubscribedAt ||
        ['OPTED_OUT', 'PROHIBITED'].includes(contact.permissionState)),
  )
  // Native suppression is current operational state, not an observed contact fact.
  // Preserve it in this immutable snapshot without baking it into future observations.
  const evaluatedInput: ChicagoRankingInput = {
    ...input,
    contacts: (input.contacts ?? []).map((contact) => ({
      ...contact,
      suppressed: contact.suppressed || suppressed,
    })),
  }
  const snapshot = await saveChicagoRanking(tx, venue.id, evaluatedInput)
  await tx.prospectVenueIntelligence.update({
    where: { venueId: venue.id },
    data: {
      rankingInput: intelligenceJson(input),
      rankingSnapshot: intelligenceJson(snapshot),
      rankingVersion: snapshot.version,
    },
  })
  return snapshot
}

/** Reversible location maintenance. Never rewrites identity, correspondence or source history. */
export async function maintainChicagoVenue(raw: unknown, actor: ChicagoActor) {
  requireMaintenance(actor)
  const input = chicagoLifecycleInput.parse(raw)
  if (input.action === 'supersede' && input.venueId === input.supersededByVenueId) {
    throw new ChicagoIntelligenceError('INVALID_INPUT', 'A venue cannot supersede itself')
  }
  // The common receipt owner skips callbacks on replay. Check every referenced ID
  // beforehand so a replay cannot reveal an out-of-scope target after grants narrow.
  await scopedVenue(input.venueId, actor.scope)
  if (input.action === 'supersede') await scopedVenue(input.supersededByVenueId, actor.scope)
  return intelligenceMutation(`lifecycle-${input.action}`, input, actor, async (tx) => {
    const venue = await scopedVenue(input.venueId, actor.scope, tx)
    const profile = requireProfile(venue, input.expectedVersion)
    if (input.action === 'restore' ? !venue.archivedAt : Boolean(venue.archivedAt)) {
      throw new ChicagoIntelligenceError(
        'CONFLICT',
        input.action === 'restore'
          ? 'Venue is already active'
          : 'Venue is already archived; restore it before changing its lifecycle',
      )
    }
    if (input.action === 'supersede') {
      const target = await scopedVenue(input.supersededByVenueId, actor.scope, tx)
      requireProfile(target, input.expectedTargetVersion)
      if (target.archivedAt || target.organization.archivedAt)
        throw new ChicagoIntelligenceError(
          'CONFLICT',
          'Superseding target must be an active venue and organization',
        )
    }
    if (input.action === 'restore' && venue.organization.archivedAt)
      throw new ChicagoIntelligenceError(
        'CONFLICT',
        'Organization is archived; restoring its location does not restore the organization',
      )
    const at = new Date().toISOString(),
      asOf = at.slice(0, 10)
    const rankingInput = currentInput(venue, asOf)
    const oldLifecycle = object(object(profile.fields).lifecycle)
    const oldDecision = object(oldLifecycle.value)
    const before = {
      revision: profile.revision,
      archivedAt: venue.archivedAt?.toISOString() ?? null,
      fields: profile.fields,
      rankingInput: profile.rankingInput,
      rankingVersion: profile.rankingVersion,
    }
    const previousExclusionReason = rankingInput.exclusionReason ?? null
    const restoreOwnedExclusion =
      input.action === 'restore' && ['archived', 'superseded'].includes(String(oldDecision.state))
    rankingInput.archived = input.action !== 'restore'
    rankingInput.exclusionReason =
      input.action === 'restore'
        ? restoreOwnedExclusion &&
          (typeof oldDecision.previousExclusionReason === 'string' ||
            oldDecision.previousExclusionReason === null)
          ? oldDecision.previousExclusionReason
          : previousExclusionReason
        : input.action === 'supersede'
          ? `Superseded by ${input.supersededByVenueId}: ${input.rationale}`
          : `Archived: ${input.rationale}`
    const state =
      input.action === 'restore'
        ? 'active'
        : input.action === 'supersede'
          ? 'superseded'
          : 'archived'
    const lifecycle = {
      value: {
        state,
        supersededByVenueId: input.action === 'supersede' ? input.supersededByVenueId : null,
        previousExclusionReason: input.action === 'restore' ? null : previousExclusionReason,
        rationale: input.rationale,
        at,
        actor: actor.id,
        runId: actor.runId,
      },
      status: 'audited-decision',
      sourceUrls: [],
      researchedAt: null,
      actor: actor.id,
    }
    const fields = { ...object(profile.fields), lifecycle }
    await advance(tx, venue.id, input.expectedVersion)
    await tx.prospectVenue.update({
      where: { id: venue.id },
      data: { archivedAt: input.action === 'restore' ? null : new Date(at), updatedBy: actor.id },
    })
    await tx.prospectVenueIntelligence.update({
      where: { venueId: venue.id },
      data: { fields: intelligenceJson(fields) },
    })
    const snapshot = await retainRanking(tx, venue, rankingInput)
    const revision = profile.revision + 1
    return {
      venueId: venue.id,
      before,
      after: {
        revision,
        archivedAt: input.action === 'restore' ? null : at,
        fields,
        rankingInput,
        rankingVersion: snapshot.version,
      },
      result: {
        venueId: venue.id,
        revision,
        lifecycle: state,
        supersededByVenueId: input.action === 'supersede' ? input.supersededByVenueId : null,
        rankingVersion: snapshot.version,
        deleted: false,
      },
    }
  })
}

/** Human judgment is audited separately from research evidence; clear is reversible. */
export async function overrideChicagoVenueRanking(raw: unknown, actor: ChicagoActor) {
  requireMaintenance(actor)
  if (actor.type !== 'HUMAN')
    throw new ChicagoIntelligenceError(
      'FORBIDDEN',
      'Only an authenticated human may set or clear a ranking override',
    )
  const input = chicagoRankingOverrideInput.parse(raw)
  await scopedVenue(input.venueId, actor.scope)
  return intelligenceMutation('ranking-override', input, actor, async (tx) => {
    if (input.expectedRankingVersion !== CHICAGO_RANKING_VERSION)
      throw new ChicagoIntelligenceError(
        'CONFLICT',
        'Ranking rules changed; review the current formula before overriding it',
      )
    const venue = await scopedVenue(input.venueId, actor.scope, tx),
      profile = requireProfile(venue, input.expectedVersion)
    const at = new Date().toISOString()
    const rankingInput = currentInput(venue, at.slice(0, 10))
    const before = {
      revision: profile.revision,
      rankingInput: profile.rankingInput,
      rankingVersion: profile.rankingVersion,
    }
    rankingInput.override =
      input.mode === 'clear'
        ? null
        : {
            actor: actor.id,
            at,
            rationale: input.rationale,
            dimension: input.dimension,
            value: input.value,
          }
    await advance(tx, venue.id, input.expectedVersion)
    const snapshot = await retainRanking(tx, venue, rankingInput)
    return {
      venueId: venue.id,
      before,
      after: {
        revision: profile.revision + 1,
        rankingInput,
        rankingVersion: snapshot.version,
        rationale: input.rationale,
      },
      result: {
        venueId: venue.id,
        revision: profile.revision + 1,
        rankingVersion: snapshot.version,
        override: snapshot.override,
      },
    }
  })
}

/** Explicit atomic batch, never an unbounded refresh or history rewrite. */
export async function refreshChicagoVenueRankings(raw: unknown, actor: ChicagoActor) {
  requireMaintenance(actor)
  const input = chicagoRankingRefreshInput.parse(raw)
  for (const target of input.targets) await scopedVenue(target.venueId, actor.scope)
  return intelligenceMutation('ranking-refresh', input, actor, async (tx) => {
    const asOf = new Date().toISOString().slice(0, 10)
    const before: unknown[] = [],
      after: unknown[] = []
    const results: Array<{
      venueId: string
      revision: number
      rankingVersion: string
      previousRankingVersion: string
      state: string
    }> = []
    // Preflight the complete batch inside the transaction before the first write.
    const venues: Venue[] = []
    for (const target of input.targets) {
      const venue = await scopedVenue(target.venueId, actor.scope, tx)
      requireProfile(venue, target.expectedVersion)
      venues.push(venue)
    }
    for (const venue of venues) {
      const profile = venue.intelligence!
      const rankingInput = currentInput(venue, asOf)
      before.push({
        venueId: venue.id,
        revision: profile.revision,
        rankingVersion: profile.rankingVersion,
        rankingInput: profile.rankingInput,
      })
      await advance(tx, venue.id, profile.revision)
      const snapshot = await retainRanking(tx, venue, rankingInput)
      const result = {
        venueId: venue.id,
        revision: profile.revision + 1,
        rankingVersion: snapshot.version,
        previousRankingVersion: profile.rankingVersion,
        state: snapshot.state,
      }
      after.push({ ...result, rankingInput })
      results.push(result)
    }
    return {
      venueId: null,
      before,
      after,
      result: {
        rankingVersion: CHICAGO_RANKING_VERSION,
        asOf,
        count: results.length,
        venues: results,
      },
    }
  })
}

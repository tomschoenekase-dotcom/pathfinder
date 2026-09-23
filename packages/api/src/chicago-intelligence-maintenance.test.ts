import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHICAGO_RANKING_VERSION, rankChicagoVenue } from '@pathfinder/db'

const mocks = vi.hoisted(() => ({ scoped: vi.fn(), mutation: vi.fn(), ranking: vi.fn(), updateVenue: vi.fn(), updateProfile: vi.fn(), advance: vi.fn() }))
vi.mock('@pathfinder/db', async () => {
  // Runtime-only pure owner keeps the API compilation boundary on the package types.
  const helperPath = '../../db/src/helpers/chicago-venue-ranking'
  return vi.importActual(helperPath)
})
vi.mock('./chicago-intelligence-service', () => ({
  ChicagoIntelligenceError: class extends Error { constructor(readonly code: string, message: string) { super(message) } },
  intelligenceJson: (value: unknown) => JSON.parse(JSON.stringify(value)),
  intelligenceMutation: mocks.mutation, saveChicagoRanking: mocks.ranking, scopedVenue: mocks.scoped,
}))

import { maintainChicagoVenue, overrideChicagoVenueRanking, refreshChicagoVenueRankings } from './chicago-intelligence-maintenance'
import { chicagoLifecycleInput, chicagoRankingOverrideInput, chicagoRankingRefreshInput } from './chicago-intelligence-maintenance-contract'
import type { ChicagoActor } from './chicago-intelligence-service'

const actor: ChicagoActor = { id: 'human-1', type: 'HUMAN', runId: 'run-1', scope: { mode: 'TERRITORIES', territoryIds: ['chicago'] }, capabilities: ['prospects.maintain'] }
const common = { idempotencyKey: 'operation-1', venueId: 'venue', expectedVersion: 1, rationale: 'Reviewed current venue identity and operational status.' }
const seed = (id: string, territoryId = 'chicago') => ({
  id, territoryId, name: id, venueType: 'museum', archivedAt: null as Date | null,
  organization: { id: `org-${id}`, archivedAt: null as Date | null }, contacts: [] as Array<Record<string, unknown>>, intelligenceReviews: [] as Array<{ reason: string }>,
  intelligence: { venueId: id, revision: 1, fields: { original: { value: 'preserved' } } as Record<string, unknown>, rankingVersion: 'chicago-venue-ranking/1.0.0',
    rankingInput: { venueId: id, asOf: '2026-09-21', territory: 'Chicago Metro', venueType: 'museum', exclusionReason: 'Original independent exclusion' } as Record<string, unknown>, rankingSnapshot: { version: 'chicago-venue-ranking/1.0.0' } },
})
type FixtureVenue = ReturnType<typeof seed>
let venues: Map<string, FixtureVenue>
let snapshots: Array<{ version: string; venueId: string }>
let receipts: Map<string, { payload: string; result: Record<string, unknown> }>
const tx = { prospectVenue: { update: mocks.updateVenue }, prospectVenueIntelligence: { update: mocks.updateProfile, updateMany: mocks.advance } }

describe('reversible Chicago intelligence maintenance', () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T19:30:00Z'))
    venues = new Map([['venue', seed('venue')], ['target', seed('target')], ['outside', seed('outside', 'another')]])
    snapshots = [{ version: 'chicago-venue-ranking/1.0.0', venueId: 'venue' }]
    receipts = new Map()
    mocks.scoped.mockImplementation(async (id: string, scope: ChicagoActor['scope']) => {
      const venue = venues.get(id)
      if (!venue || scope.mode !== 'ALL' && !scope.territoryIds.includes(venue.territoryId)) throw Object.assign(new Error('Missing or outside scope'), { code: 'NOT_FOUND' })
      return structuredClone(venue)
    })
    mocks.advance.mockImplementation(async ({ where }: { where: { venueId: string; revision: number } }) => {
      const venue = venues.get(where.venueId)
      if (!venue || venue.intelligence.revision !== where.revision) return { count: 0 }
      venue.intelligence.revision++
      return { count: 1 }
    })
    mocks.updateVenue.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(venues.get(where.id)!, data))
    mocks.updateProfile.mockImplementation(async ({ where, data }: { where: { venueId: string }; data: Record<string, unknown> }) => Object.assign(venues.get(where.venueId)!.intelligence, data))
    mocks.ranking.mockImplementation(async (_tx, venueId, input) => { const value = rankChicagoVenue(input); snapshots.push({ venueId, version: value.version }); return value })
    // Adapter fixture: the production transaction/receipt owner is tested separately.
    mocks.mutation.mockImplementation(async (operation, input, who, apply) => {
      const key = `${who.id}:${who.runId}:${input.idempotencyKey}`, payload = JSON.stringify({ operation, input })
      const prior = receipts.get(key)
      if (prior) {
        if (prior.payload !== payload) throw Object.assign(new Error('Different payload'), { code: 'CONFLICT' })
        return { ...prior.result, replayed: true }
      }
      const changed = await apply(tx, `receipt-${input.idempotencyKey}`)
      const result = { receiptId: `receipt-${input.idempotencyKey}`, replayed: false, ...changed.result }
      receipts.set(key, { payload, result })
      return result
    })
  })
  afterEach(() => vi.useRealTimers())

  it('archives and restores the exact location while preserving identity and the prior exclusion', async () => {
    const archived = await maintainChicagoVenue({ ...common, action: 'archive' }, actor)
    expect(archived).toMatchObject({ venueId: 'venue', revision: 2, lifecycle: 'archived', deleted: false })
    expect(venues.get('venue')?.archivedAt).toEqual(new Date('2026-09-22T19:30:00Z'))
    expect(venues.get('venue')?.intelligence.rankingInput.exclusionReason).toContain('Archived:')
    const restored = await maintainChicagoVenue({ ...common, idempotencyKey: 'restore-1', expectedVersion: 2, action: 'restore' }, actor)
    expect(restored).toMatchObject({ revision: 3, lifecycle: 'active' })
    expect(venues.get('venue')?.archivedAt).toBeNull()
    expect(venues.get('venue')?.intelligence.rankingInput.exclusionReason).toBe('Original independent exclusion')
    expect(venues.get('venue')?.intelligence.fields.original).toEqual({ value: 'preserved' })
    expect(venues.get('venue')?.name).toBe('venue')
    expect(snapshots[0]).toEqual({ venueId: 'venue', version: 'chicago-venue-ranking/1.0.0' })
    expect(mocks.updateVenue.mock.calls.every(([call]) => Object.keys(call.data).every(key => ['archivedAt', 'updatedBy'].includes(key)))).toBe(true)
  })

  it('supersedes only toward an exact active scoped target without merging either identity', async () => {
    const targetBefore = structuredClone(venues.get('target'))
    const result = await maintainChicagoVenue({ ...common, action: 'supersede', supersededByVenueId: 'target', expectedTargetVersion: 1 }, actor)
    expect(result).toMatchObject({ lifecycle: 'superseded', supersededByVenueId: 'target', deleted: false })
    expect(venues.get('target')).toEqual(targetBefore)
    expect(venues.get('venue')?.intelligence.rankingInput.exclusionReason).toContain('Superseded by target')
    await maintainChicagoVenue({ ...common, action: 'restore', expectedVersion: 2, idempotencyKey: 'undo-supersede' }, actor)
    expect(venues.get('venue')?.archivedAt).toBeNull()
    expect(venues.get('venue')?.intelligence.rankingInput.exclusionReason).toBe('Original independent exclusion')
  })

  it('rejects self-supersede, target scope/state/version errors and stale source before writing', async () => {
    const supersede = { ...common, action: 'supersede', supersededByVenueId: 'venue', expectedTargetVersion: 1 }
    await expect(maintainChicagoVenue(supersede, actor)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(maintainChicagoVenue({ ...supersede, supersededByVenueId: 'outside' }, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(maintainChicagoVenue({ ...supersede, supersededByVenueId: 'target', expectedTargetVersion: 2 }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    venues.get('target')!.archivedAt = new Date()
    await expect(maintainChicagoVenue({ ...supersede, supersededByVenueId: 'target' }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(maintainChicagoVenue({ ...common, action: 'archive', expectedVersion: 2 }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.advance).not.toHaveBeenCalled()
  })

  it('replays archive even after it becomes archived, but rechecks all referenced scopes', async () => {
    const input = { ...common, action: 'supersede', supersededByVenueId: 'target', expectedTargetVersion: 1 }
    await maintainChicagoVenue(input, actor)
    expect(await maintainChicagoVenue(input, actor)).toMatchObject({ replayed: true, revision: 2 })
    expect(mocks.advance).toHaveBeenCalledTimes(1)
    venues.get('target')!.territoryId = 'outside'
    await expect(maintainChicagoVenue(input, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('denies agent/system overrides and derives human identity/date from trusted context', async () => {
    const input = { ...common, mode: 'set', expectedRankingVersion: CHICAGO_RANKING_VERSION, dimension: 'productFit', value: 94 }
    for (const type of ['AGENT', 'SYSTEM'] as const) await expect(overrideChicagoVenueRanking(input, { ...actor, type })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.mutation).not.toHaveBeenCalled()
    const result = await overrideChicagoVenueRanking(input, actor)
    expect(result).toMatchObject({ revision: 2, override: { actor: 'human-1', at: '2026-09-22T19:30:00.000Z', value: 94, rationale: common.rationale } })
    expect(venues.get('venue')?.intelligence.rankingInput.fit).toBeUndefined()
    await overrideChicagoVenueRanking({ ...common, idempotencyKey: 'clear-1', expectedVersion: 2, mode: 'clear', expectedRankingVersion: CHICAGO_RANKING_VERSION }, actor)
    expect(venues.get('venue')?.intelligence.rankingInput.override).toBeNull()
  })

  it('rejects changed ranking rules, injected actor/date and CAS contention', async () => {
    const input = { ...common, mode: 'set', expectedRankingVersion: 'chicago-venue-ranking/1.0.0', dimension: 'productFit', value: 94 }
    await expect(overrideChicagoVenueRanking(input, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(overrideChicagoVenueRanking({ ...input, expectedRankingVersion: CHICAGO_RANKING_VERSION, actor: 'invented', at: '2026-09-01' }, actor)).rejects.toThrow()
    mocks.advance.mockResolvedValueOnce({ count: 0 })
    await expect(overrideChicagoVenueRanking({ ...input, expectedRankingVersion: CHICAGO_RANKING_VERSION }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.ranking).not.toHaveBeenCalled()
  })

  it('refreshes bounded explicit IDs, records previous rules and preserves old snapshots and suppression', async () => {
    venues.get('venue')!.contacts = [{ archivedAt: null, doNotContact: true, permissionState: 'UNKNOWN' }]
    venues.get('venue')!.intelligence.rankingInput.contacts = [{ kind: 'email', verified: true, suppressed: false, roleRelevant: true, sourceUrls: ['https://museum.example.org/contact'], researchedAt: '2026-09-22' }]
    const input = { idempotencyKey: 'refresh-1', rationale: common.rationale, targets: [{ venueId: 'venue', expectedVersion: 1 }, { venueId: 'target', expectedVersion: 1 }] }
    const result = await refreshChicagoVenueRankings(input, actor)
    expect(result).toMatchObject({ count: 2, rankingVersion: CHICAGO_RANKING_VERSION, venues: [
      { venueId: 'venue', revision: 2, previousRankingVersion: 'chicago-venue-ranking/1.0.0' },
      { venueId: 'target', revision: 2, previousRankingVersion: 'chicago-venue-ranking/1.0.0' },
    ] })
    expect(snapshots).toHaveLength(3)
    expect(snapshots[0]?.version).toBe('chicago-venue-ranking/1.0.0')
    expect(mocks.ranking.mock.calls[0]?.[2].contacts[0].suppressed).toBe(true)
    expect(await refreshChicagoVenueRankings(input, actor)).toMatchObject({ replayed: true, count: 2 })
    expect(mocks.ranking).toHaveBeenCalledTimes(2)
    venues.get('target')!.territoryId = 'outside'
    await expect(refreshChicagoVenueRankings(input, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('preflights every requested refresh version before the first batch write', async () => {
    await expect(refreshChicagoVenueRankings({ idempotencyKey: 'refresh', rationale: common.rationale, targets: [{ venueId: 'venue', expectedVersion: 1 }, { venueId: 'target', expectedVersion: 2 }] }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.advance).not.toHaveBeenCalled()
    expect(mocks.ranking).not.toHaveBeenCalled()
  })

  it('recomputes native suppression after it is cleared without rewriting observed contacts or prior snapshots', async () => {
    const venue = venues.get('venue')!
    const contacts = [{ kind: 'email', verified: true, suppressed: false, roleRelevant: true, sourceUrls: ['https://museum.example.org/contact'], researchedAt: '2026-09-22' }]
    venue.intelligence.rankingInput.contacts = structuredClone(contacts)
    venue.contacts = [{ archivedAt: null, doNotContact: true, permissionState: 'UNKNOWN' }]
    const refresh = (idempotencyKey: string, expectedVersion: number) => refreshChicagoVenueRankings({ idempotencyKey, rationale: common.rationale, targets: [{ venueId: 'venue', expectedVersion }] }, actor)
    await refresh('suppressed-refresh', 1)
    const suppressedInput = mocks.ranking.mock.calls[0]![2]
    const historicalInput = JSON.stringify(suppressedInput)
    expect(rankChicagoVenue(suppressedInput).contactability.value).toBe(0)
    expect(venue.intelligence.rankingInput.contacts).toEqual(contacts)

    venue.contacts[0]!.doNotContact = false
    await refresh('unsuppressed-refresh', 2)
    const currentInput = mocks.ranking.mock.calls[1]![2]
    expect(currentInput.contacts[0].suppressed).toBe(false)
    expect(rankChicagoVenue(currentInput).contactability.value).toBe(85)
    expect(venue.intelligence.rankingInput.contacts).toEqual(contacts)
    expect(JSON.stringify(suppressedInput)).toBe(historicalInput)

    // An independently recorded suppression is not cleared by native state alone.
    venue.intelligence.rankingInput.contacts = [{ ...contacts[0], suppressed: true }]
    await refresh('observed-suppression', 3)
    expect(rankChicagoVenue(mocks.ranking.mock.calls[2]![2]).contactability.value).toBe(0)
  })

  it('excludes an organization-archived location during refresh and override without changing location lifecycle', async () => {
    const venue = venues.get('venue')!
    venue.organization.archivedAt = new Date('2026-09-01T00:00:00Z')
    venue.intelligence.rankingInput.exclusionReason = null
    await refreshChicagoVenueRankings({ idempotencyKey: 'organization-archive', rationale: common.rationale, targets: [{ venueId: 'venue', expectedVersion: 1 }] }, actor)
    expect(rankChicagoVenue(mocks.ranking.mock.calls[0]![2]).state).toBe('excluded')
    await overrideChicagoVenueRanking({ ...common, idempotencyKey: 'organization-override', expectedVersion: 2, expectedRankingVersion: CHICAGO_RANKING_VERSION, mode: 'set', dimension: 'productFit', value: 95 }, actor)
    const ranking = rankChicagoVenue(mocks.ranking.mock.calls[1]![2])
    expect(ranking.state).toBe('excluded')
    expect(ranking.rankKey).toEqual([null, null, null, null])
    expect(venue.archivedAt).toBeNull()
    expect(venue.intelligence.fields.lifecycle).toBeUndefined()
    expect(mocks.updateVenue).not.toHaveBeenCalled()
  })

  it('enforces strict schemas, bounded batches and maintenance permission before reads', async () => {
    expect(chicagoLifecycleInput.safeParse({ ...common, action: 'archive', hardDelete: true }).success).toBe(false)
    expect(chicagoRankingOverrideInput.safeParse({ ...common, mode: 'set', expectedRankingVersion: CHICAGO_RANKING_VERSION, dimension: 'productFit', value: 101 }).success).toBe(false)
    const refresh = { idempotencyKey: 'refresh', rationale: common.rationale, targets: [{ venueId: 'venue', expectedVersion: 1 }] }
    expect(chicagoRankingRefreshInput.safeParse({ ...refresh, targets: [] }).success).toBe(false)
    expect(chicagoRankingRefreshInput.safeParse({ ...refresh, targets: [...refresh.targets, ...refresh.targets] }).success).toBe(false)
    expect(chicagoRankingRefreshInput.safeParse({ ...refresh, targets: Array.from({ length: 101 }, (_, index) => ({ venueId: String(index), expectedVersion: 1 })) }).success).toBe(false)
    await expect(maintainChicagoVenue({ ...common, action: 'archive' }, { ...actor, capabilities: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.scoped).not.toHaveBeenCalled()
  })
})

import { describe, it, expect } from 'vitest'
import {
  cohortHash,
  planOutreachCohort,
  outreachCohortPreviewInput,
  outreachCohortWindowInput,
  type CohortCandidate,
} from './prospect-outreach-cohort-contract'

function candidate(i: number): CohortCandidate {
  return {
    venueId: `SYN-V${i}`,
    organizationId: `SYN-O${i}`,
    name: `Synthetic ${i}`,
    contactId: `SYN-C${i}`,
    recipient: `fixture${i}@example.invalid`,
    city: 'Chicago',
    region: 'IL',
    geographyStatus: 'ASSIGNED',
    countyGeoid: '17031',
    size: 'small',
    sizeVerified: true,
    relationshipTier: 'STANDARD',
    opportunityStage: 'RESEARCHED',
    nativeSnapshotHash: 'a'.repeat(64),
    currentDraftId: null,
    sourceIds: [`SYN-S${i}`],
    sourceCount: 1,
    suppressed: false,
    suppressionReasons: [],
    history: 'NO_RETAINED_HISTORY',
    identityReviewOpen: false,
    priorGroupIds: [],
    priorContactReservation: false,
    contactSelected: true,
    contactVerified: true,
  }
}
const input = (rows: CohortCandidate[], count = 50) =>
  outreachCohortPreviewInput.parse({
    question: 'Prepare synthetic small Chicago venues for individual review.',
    candidates: rows.map((r) => ({ venueId: r.venueId, contactId: r.contactId })),
    count,
    excludePriorGroups: true,
  })
describe('bounded native outreach cohort selection', () => {
  it('admits at most 50, with no fabricated 51st selection', () => {
    const rows = Array.from({ length: 105 }, (_, i) => candidate(i))
    const first = planOutreachCohort(input(rows), rows)
    expect(first.selectedCount).toBe(50)
    expect(first.rows.filter((r) => r.selected)).toHaveLength(50)
    expect(outreachCohortPreviewInput.safeParse({ ...input(rows), count: 51 }).success).toBe(false)
    expect(
      outreachCohortWindowInput.safeParse({ cohortId: 'one', requestKey: 'r1', limit: 6 }).success,
    ).toBe(false)
  })
  it('50 more excludes all prior groups, even if their work is still held', () => {
    const rows = Array.from({ length: 105 }, (_, i) => ({
      ...candidate(i),
      priorGroupIds: i < 50 ? ['prior'] : [],
    }))
    const next = planOutreachCohort(input(rows), rows)
    expect(next.excludedCount).toBe(50)
    expect(next.rows.filter((r) => r.selected).map((r) => r.venueId)).toEqual(
      rows.slice(50, 100).map((r) => r.venueId),
    )
  })
  it('keeps unknown size, geography, contact and incomplete history as explicit held rows', () => {
    const rows = [
      { ...candidate(1), sizeVerified: false },
      { ...candidate(2), geographyStatus: 'GEO_HOLD' },
      { ...candidate(3), contactSelected: false },
      { ...candidate(4), history: 'INCOMPLETE_OR_UNAVAILABLE' as const },
    ]
    const result = planOutreachCohort(input(rows), rows)
    expect(result.heldCount).toBe(4)
    expect(result.readyForNativeGate).toBe(0)
    expect(result.shortfall).toBe(46)
    expect(result.rows[3]!.reasons).toContain('HISTORY_UNAVAILABLE_NOT_NO_HISTORY')
  })
  it('excludes suppressed, large/strategic, existing draft/history and cross-scope reservations', () => {
    const rows = [
      { ...candidate(1), suppressed: true },
      { ...candidate(2), size: 'large' },
      { ...candidate(3), relationshipTier: 'STRATEGIC' },
      { ...candidate(4), currentDraftId: 'draft' },
      { ...candidate(5), history: 'RETAINED_HISTORY' as const },
      { ...candidate(6), priorContactReservation: true },
    ]
    expect(planOutreachCohort(input(rows), rows).excludedCount).toBe(6)
  })
  it('deduplicates canonical organization and exact mailbox, not generic shared domains', () => {
    const rows = [
      candidate(1),
      { ...candidate(2), organizationId: 'SYN-O1' },
      { ...candidate(3), recipient: 'FIXTURE1@example.invalid' },
      candidate(4),
    ]
    const result = planOutreachCohort(input(rows), rows)
    expect(result.selectedCount).toBe(2)
    expect(result.rows[3]!.selected).toBe(true)
  })
  it('requires complete exact candidate order and changes hashes on recipient/source change', () => {
    const rows = [candidate(1), candidate(2)]
    expect(() => planOutreachCohort(input(rows), rows.slice(1))).toThrow(/complete/)
    expect(() => planOutreachCohort(input(rows), [...rows].reverse())).toThrow(/complete/)
    expect(cohortHash({ a: 1, b: 2 })).toBe(cohortHash({ b: 2, a: 1 }))
    const changed = [{ ...rows[0]!, nativeSnapshotHash: 'b'.repeat(64) }, rows[1]!]
    expect(planOutreachCohort(input(rows), rows).previewHash).not.toBe(
      planOutreachCohort(input(changed), changed).previewHash,
    )
  })
})

import { describe, expect, it } from 'vitest'

import { SupportCompletionNoChangeFulfillment } from './agent-approval-policy'

const receipt = {
  outcome: 'DUPLICATE_NOOP' as const,
  resolutionId: 'resolution_1',
  proposalId: 'proposal_1',
  sourceProposalId: 'proposal_1',
  sourceRequestVersion: 3,
  replacementOfProposalId: null,
  proposalUpdatedAt: '2026-09-10T11:00:00.000Z',
  targetKnowledgeEntryId: 'entry_1',
  targetSnapshotHash: 'a'.repeat(64),
  observedStateHash: 'b'.repeat(64),
  decisionCreatedAt: '2026-09-10T11:01:00.000Z',
  contentModuleId: null,
  contentRevisionId: null,
  contentPublicationId: null,
  effectiveFrom: null,
  effectiveUntil: null,
  operationalFactExpiresAt: null,
}
const value = {
  contractVersion: 1 as const,
  receipts: [receipt],
  guestRead: { path: 'LEGACY' as const, releaseId: null, nativeStateHash: null },
  verifiedAt: '2026-09-10T12:00:00.000Z',
  digest: 'c'.repeat(64),
}

describe('SupportCompletionNoChangeFulfillment', () => {
  it('accepts an exact current public no-change receipt', () => {
    expect(SupportCompletionNoChangeFulfillment.parse(value)).toEqual(value)
  })

  it.each([
    ['duplicate resolution', { receipts: [receipt, { ...receipt }] }],
    ['duplicate proposal', { receipts: [receipt, { ...receipt, resolutionId: 'resolution_2' }] }],
    ['unknown outcome', { receipts: [{ ...receipt, outcome: 'UPDATED' }] }],
    ['partial native links', { receipts: [{ ...receipt, contentModuleId: 'module_1' }] }],
    ['expired window', { receipts: [{ ...receipt, effectiveUntil: '2026-09-10T12:00:00.000Z' }] }],
    ['future window', { receipts: [{ ...receipt, effectiveFrom: '2026-09-10T12:00:01.000Z' }] }],
    [
      'empty receipt path mismatch',
      { receipts: [], guestRead: { ...value.guestRead, path: 'LEGACY' } },
    ],
    [
      'nonempty receipt path mismatch',
      { guestRead: { ...value.guestRead, path: 'NOT_APPLICABLE' } },
    ],
  ])('rejects %s', (_label, override) => {
    expect(SupportCompletionNoChangeFulfillment.safeParse({ ...value, ...override }).success).toBe(
      false,
    )
  })

  it('uses inclusive start and exclusive end bounds', () => {
    expect(
      SupportCompletionNoChangeFulfillment.safeParse({
        ...value,
        receipts: [{ ...receipt, effectiveFrom: value.verifiedAt }],
      }).success,
    ).toBe(true)
    expect(
      SupportCompletionNoChangeFulfillment.safeParse({
        ...value,
        receipts: [{ ...receipt, effectiveUntil: value.verifiedAt }],
      }).success,
    ).toBe(false)
  })
})

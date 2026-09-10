import { describe, expect, it } from 'vitest'
import { SemanticReviewedDeclineInput } from './semantic-reviewed-decline-contract'

const valid = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  proposalId: '22222222-2222-4222-8222-222222222222',
  expectedProposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  resolutionNote: 'Reviewed and declined with the current source evidence.',
}

describe('SemanticReviewedDeclineInput', () => {
  it('accepts an exact cloned plain input', () => {
    expect(SemanticReviewedDeclineInput.parse(structuredClone(valid))).toEqual(valid)
  })

  it('rejects forged fields and non-plain objects', () => {
    expect(SemanticReviewedDeclineInput.safeParse({ ...valid, actorId: 'forged' }).success).toBe(
      false,
    )
    expect(
      SemanticReviewedDeclineInput.safeParse(Object.assign(Object.create(null), valid)).success,
    ).toBe(false)
    expect(SemanticReviewedDeclineInput.safeParse([valid]).success).toBe(false)
  })

  it('rejects malformed operation, scope, time, and note', () => {
    expect(
      SemanticReviewedDeclineInput.safeParse({ ...valid, operationId: 'not-a-uuid' }).success,
    ).toBe(false)
    expect(SemanticReviewedDeclineInput.safeParse({ ...valid, tenantId: '   ' }).success).toBe(
      false,
    )
    expect(
      SemanticReviewedDeclineInput.safeParse({ ...valid, expectedProposalUpdatedAt: 'soon' })
        .success,
    ).toBe(false)
    expect(
      SemanticReviewedDeclineInput.safeParse({ ...valid, resolutionNote: '   ' }).success,
    ).toBe(false)
    expect(
      SemanticReviewedDeclineInput.safeParse({ ...valid, resolutionNote: 'x'.repeat(2001) })
        .success,
    ).toBe(false)
  })
})

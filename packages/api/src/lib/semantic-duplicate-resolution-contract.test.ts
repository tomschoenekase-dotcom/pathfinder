import { describe, expect, it } from 'vitest'

import { SemanticDuplicateResolutionInput } from './semantic-duplicate-resolution-contract'

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  proposalId: '22222222-2222-4222-8222-222222222222',
  expectedProposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  expectedPreviewHash: 'a'.repeat(64),
  relation: 'NEW_FACT' as const,
  desired: { title: 'Hours', category: 'POLICY', content: 'Open daily.', isEnabled: true },
  resolutionNote: 'The published entry already matches the reviewed support evidence.',
}

describe('SemanticDuplicateResolutionInput', () => {
  it('accepts an exact plain-object clone', () => {
    expect(
      SemanticDuplicateResolutionInput.parse({ ...input, desired: { ...input.desired } }),
    ).toEqual(input)
  })

  it('rejects forged fields outside the resolution contract', () => {
    expect(
      SemanticDuplicateResolutionInput.safeParse({
        ...input,
        matchedKnowledgeEntryId: 'forged',
        actorId: 'forged',
      }).success,
    ).toBe(false)
  })

  it.each([
    ['operation', { operationId: 'not-a-uuid' }],
    ['hash', { expectedPreviewHash: 'A'.repeat(64) }],
    ['time', { expectedProposalUpdatedAt: 'not-a-time' }],
  ])('rejects invalid %s identity values', (_label, override) => {
    expect(SemanticDuplicateResolutionInput.safeParse({ ...input, ...override }).success).toBe(
      false,
    )
  })

  it('rejects disabled guidance as a duplicate fulfillment outcome', () => {
    expect(
      SemanticDuplicateResolutionInput.safeParse({
        ...input,
        desired: { ...input.desired, isEnabled: false },
      }).success,
    ).toBe(false)
  })

  it.each([Object.create(null), [], new Date(), { ...input, desired: [] }])(
    'rejects malformed or nonplain input',
    (value) => {
      expect(SemanticDuplicateResolutionInput.safeParse(value).success).toBe(false)
    },
  )
})

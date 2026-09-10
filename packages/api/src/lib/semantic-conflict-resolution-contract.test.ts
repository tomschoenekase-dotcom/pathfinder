import { describe, expect, it } from 'vitest'

import {
  hashSemanticConflictAnswer,
  hashSemanticConflictTarget,
  SemanticConflictResolutionInput,
} from './semantic-conflict-resolution-contract'

const validInput = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  proposalId: '22222222-2222-4222-8222-222222222222',
  expectedProposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  expectedPreviewHash: 'a'.repeat(64),
  questionId: 'question-1',
  expectedQuestionUpdatedAt: '2026-09-10T12:01:00.000Z',
  expectedAnsweredAt: '2026-09-10T12:01:00.000Z',
  expectedAnswerHash: 'b'.repeat(64),
  relation: 'CORRECTS',
  desired: {
    title: 'Gallery hours',
    category: 'Hours',
    content: 'The gallery closes at 7 PM.',
    isEnabled: true,
  },
  replacementDesired: {
    title: 'Gallery hours',
    category: 'Hours',
    content: 'The signed hours sheet confirms that the gallery closes at 6 PM.',
    isEnabled: true,
  },
  outcome: 'PROPOSE_REPLACEMENT',
  resolutionNote: 'Use the operator answer as evidence for a new reviewable proposal.',
} as const

const target = {
  id: 'knowledge-1',
  title: 'Gallery hours',
  category: 'Hours',
  content: 'The gallery closes at 5 PM.',
  isEnabled: true,
  humanConfirmedAt: new Date('2026-09-10T11:00:00.000Z'),
  authorship: 'HUMAN_AUTHORED',
  sourceType: 'PATHFINDER_INTAKE',
}

describe('semantic conflict resolution contract', () => {
  it('accepts only the explicit human adjudication envelope', () => {
    expect(SemanticConflictResolutionInput.parse(validInput)).toEqual(validInput)

    for (const invalid of [
      { ...validInput, expectedAnsweredAt: 'yesterday' },
      { ...validInput, expectedAnswerHash: 'A'.repeat(64) },
      { ...validInput, relation: 'NEW_FACT' },
      { ...validInput, outcome: 'APPROVE_AND_PUBLISH' },
      { ...validInput, replacementDesired: undefined },
      { ...validInput, outcome: 'KEEP_CANONICAL' },
      { ...validInput, resolutionNote: '   ' },
      { ...validInput, unexpectedAuthority: true },
      { ...validInput, desired: { ...validInput.desired, approved: true } },
    ]) {
      expect(SemanticConflictResolutionInput.safeParse(invalid).success).toBe(false)
    }

    const inherited = Object.create({ approvalGranted: true }) as Record<string, unknown>
    Object.assign(inherited, validInput)
    expect(SemanticConflictResolutionInput.safeParse(inherited).success).toBe(false)

    const keepCanonical: Partial<typeof validInput> = { ...validInput }
    delete keepCanonical.replacementDesired
    expect(
      SemanticConflictResolutionInput.parse({
        ...keepCanonical,
        outcome: 'KEEP_CANONICAL',
      }),
    ).not.toHaveProperty('replacementDesired')
  })

  it('hashes the exact answer without normalization', () => {
    const baseline = hashSemanticConflictAnswer('Use the signed hours sheet.')
    expect(baseline).toMatch(/^[a-f0-9]{64}$/u)
    expect(hashSemanticConflictAnswer('Use the signed hours sheet. ')).not.toBe(baseline)
    expect(hashSemanticConflictAnswer('use the signed hours sheet.')).not.toBe(baseline)
  })

  it('binds canonical content, confirmation time, authorship, and source type', () => {
    const baseline = hashSemanticConflictTarget(target)
    expect(baseline).toMatch(/^[a-f0-9]{64}$/u)
    expect(hashSemanticConflictTarget({ ...target })).toBe(baseline)

    for (const changed of [
      { ...target, content: 'The gallery closes at 7 PM.' },
      { ...target, humanConfirmedAt: new Date('2026-09-10T11:01:00.000Z') },
      { ...target, authorship: 'AI_GENERATED' },
      { ...target, sourceType: 'PUBLIC_WEBSITE' },
      { ...target, isEnabled: false },
    ]) {
      expect(hashSemanticConflictTarget(changed)).not.toBe(baseline)
    }

    expect(() => hashSemanticConflictTarget({ ...target, approvalGranted: true })).toThrow()
    const inherited = Object.create({ authority: 'VENUE_CONFIRMED' }) as typeof target
    Object.assign(inherited, target)
    expect(() => hashSemanticConflictTarget(inherited)).toThrow()
  })
})

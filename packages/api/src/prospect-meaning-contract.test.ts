import { describe, expect, it } from 'vitest'
import { salesMeaningInput } from './prospect-meaning-contract'
import { salesLocalAction } from './prospect-sales-contract'

function input() {
  return {
    venueId: 'venue',
    draftId: 'draft',
    contentHash: 'a'.repeat(64),
    expectedSnapshotHash: 'b'.repeat(64),
    expectedBindingHash: 'c'.repeat(64),
    expectedMeaningReviewId: null,
    annotations: [
      {
        annotation_id: 'A1',
        section: 'subject',
        start: 0,
        end: 3,
        quote: 'Hi,',
        category: 'NONFACTUAL',
        claim_ids: [],
        reason: 'This is an ordinary greeting only.',
        answers: [],
      },
    ],
    reviewer: { kind: 'model', identity: 'Synthetic model assessment' },
    assessments: [
      { annotation_id: 'A1', verdict: 'uncertain', reason: 'Not a complete draft assessment yet.' },
    ],
    languageUses: [],
    answers: [],
    unsupportedClaims: ['Coverage remains unresolved.'],
  }
}
describe('strict native meaning review boundary', () => {
  it('accepts attributed failed findings without creating any approval property', () => {
    const result = salesLocalAction.parse({ action: 'meaning', input: input() })
    expect(result.action).toBe('meaning')
    expect('SEND_AUTHORIZED' in result.input).toBe(false)
  })
  it.each([
    'SEND_AUTHORIZED',
    'actor',
    'component',
    'preparationId',
    'humanApproval',
    'status',
    'semanticCertification',
  ])('rejects client-supplied %s authority or computed evidence', (key) => {
    expect(() => salesMeaningInput.parse({ ...input(), [key]: true })).toThrow()
  })
  it.each([
    'contentHash',
    'expectedSnapshotHash',
    'expectedBindingHash',
    'expectedMeaningReviewId',
    'reviewer',
  ])('requires explicit %s binding or concurrency identity', (key) => {
    const value = input() as Record<string, unknown>
    delete value[key]
    expect(() => salesMeaningInput.parse(value)).toThrow()
  })
  it('bounds the annotation and reason payload; forbids arbitrary verdict and identity types', () => {
    const value = input()
    expect(() =>
      salesMeaningInput.parse({ ...value, annotations: Array(81).fill(value.annotations[0]) }),
    ).toThrow()
    expect(() =>
      salesMeaningInput.parse({
        ...value,
        reviewer: { kind: 'authenticated-Tom', identity: 'Tom' },
      }),
    ).toThrow()
    expect(() =>
      salesMeaningInput.parse({
        ...value,
        assessments: [{ ...value.assessments[0], verdict: 'approved-for-send' }],
      }),
    ).toThrow()
  })
})

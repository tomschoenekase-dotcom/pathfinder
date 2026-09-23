import { describe, expect, it } from 'vitest'
import { nativeWriterResult, writerImportInput } from './prospect-writer-contract'

function result() {
  const h = 'a'.repeat(64)
  return {
    schema: 'torchiko.native-writer-result/1',
    taskId: 'writer-task_' + h,
    binding: {
      venueId: 'venue',
      organizationId: 'org',
      preparationId: 'prep',
      nativeSnapshotHash: h,
      preparationHash: h,
      componentCodeHash: h,
      fileSetHash: h,
      selectionId: null,
      routeHash: h,
      routeKind: 'email',
      recipient: 'fixture@example.invalid',
      formUrl: null,
      threadHash: h,
      libraryHash: h,
      wltHash: h,
      expectedDraftId: null,
      expectedVenueDraftId: null,
      expectedMeaningReviewId: null,
      expectedReadReviewId: null,
    },
    generatedBy: { kind: 'model', identity: 'Explicit synthetic unit model' },
    subject: 'Hello',
    body: 'Hi, 🌿',
    annotations: [
      {
        annotation_id: 's',
        section: 'subject',
        start: 0,
        end: 5,
        quote: 'Hello',
        category: 'NONFACTUAL',
        claim_ids: [],
        reason: 'Synthetic exact greeting only.',
        answers: [],
      },
      {
        annotation_id: 'b',
        section: 'body',
        start: 0,
        end: 5,
        quote: 'Hi, 🌿',
        category: 'NONFACTUAL',
        claim_ids: [],
        reason: 'Synthetic Unicode offset test only.',
        answers: [],
      },
    ],
    languageUses: [],
    assessment: null,
  }
}
describe('strict native AI result transport, not semantic approval', () => {
  it('retains exact Unicode code-point text and optional missing assessment', () => {
    expect(nativeWriterResult.parse(result()).body).toBe('Hi, 🌿')
  })
  it.each([
    'actor',
    'approved',
    'SEND_AUTHORIZED',
    'sourceFacts',
    'writerContext',
    'filePath',
    'url',
  ])('rejects client authority/source/path field %s', (field) => {
    expect(nativeWriterResult.safeParse({ ...result(), [field]: true }).success).toBe(false)
  })
  it('rejects a claimed human generator', () => {
    const r = result()
    r.generatedBy.kind = 'human'
    expect(nativeWriterResult.safeParse(r).success).toBe(false)
  })
  it('rejects a claimed authenticated human assessor', () => {
    expect(
      nativeWriterResult.safeParse({
        ...result(),
        assessment: {
          reviewer: { kind: 'human', identity: 'Tom' },
          assessments: [],
          answers: [],
          unsupportedClaims: [],
        },
      }).success,
    ).toBe(false)
  })
  it('accepts attributed uncertain assessments without laundering them into supported', () => {
    const r = nativeWriterResult.parse({
      ...result(),
      assessment: {
        reviewer: { kind: 'model', identity: 'Test assessor' },
        assessments: [
          {
            annotation_id: 's',
            verdict: 'uncertain',
            reason: 'Uncertainty must stay an unresolved hold.',
          },
        ],
        answers: [],
        unsupportedClaims: ['Unresolved claim'],
      },
    })
    expect(r.assessment?.assessments[0]?.verdict).toBe('uncertain')
  })
  it.each(['overlap', 'missing', 'utf16', 'changed', 'duplicate'])(
    'rejects malformed exact spans: %s',
    (mode) => {
      const r = result()
      if (mode === 'overlap') r.annotations.push({ ...r.annotations[1]!, annotation_id: 'extra' })
      if (mode === 'missing') r.annotations.pop()
      if (mode === 'utf16') r.annotations[1]!.end = 6
      if (mode === 'changed') r.body = 'Hi, X'
      if (mode === 'duplicate') r.annotations[1]!.annotation_id = 's'
      expect(nativeWriterResult.safeParse(r).success).toBe(false)
    },
  )
  it('refuses wrong-venue transport binding', () => {
    const r = result()
    expect(
      writerImportInput.safeParse({
        venueId: 'other',
        expectedSnapshotHash: r.binding.nativeSnapshotHash,
        result: r,
      }).success,
    ).toBe(false)
  })
  it('does not accept a new source snapshot supplied outside the exported task', () => {
    expect(
      writerImportInput.safeParse({
        venueId: 'venue',
        expectedSnapshotHash: 'b'.repeat(64),
        result: result(),
      }).success,
    ).toBe(false)
  })
})

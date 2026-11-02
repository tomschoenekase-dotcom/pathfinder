import { describe, expect, it } from 'vitest'
import { assembleGuestEvidence } from './guest-evidence-assembly'
import { guestAnswerShape } from './guest-evidence-answer-shape'

describe('conservative notice relevance across question wording', () => {
  it.each([
    '¿Puedo usar el Cloud Pass?',
    'Puis-je utiliser le Cloud Pass ?',
    'Cloud Passを使えますか？',
    'I would like to redeem the Cloud Pass.',
  ])('does not assume an unrecognized use question is a narrow fact lookup: %s', (question) => {
    const result = assembleGuestEvidence({
      question,
      visitorMessages: [question],
      shape: guestAnswerShape(question),
      records: [
        {
          ref: 'knowledge:cloud-pass',
          title: 'Cloud Pass',
          content:
            'Cloud Pass is a return pass.\nMust mention: Taking a Cloud Pass ends your admission today.',
          version: null,
        },
      ],
      retrievedRefs: [],
      previous: null,
      unavailableRefs: [],
      coverage: { mode: 'FULL', incomplete: false, retrievalPartial: false, loadFailed: false },
      escape: (value) => value,
    })
    expect(result.notices[0]?.requiredForQuestion).toBe(true)
  })
})

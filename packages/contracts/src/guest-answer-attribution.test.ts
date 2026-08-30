import { describe, expect, it } from 'vitest'

import {
  createGuestAnswerAttribution,
  GUEST_ANSWER_EVIDENCE_VERSION,
  type GuestAnswerEvidenceBundle,
} from './guest-answer-attribution'
import { GUEST_CHAT_PROMPT_VERSION } from './prompt-contract'

const hash = 'a'.repeat(64)
const evidence: GuestAnswerEvidenceBundle = {
  schemaVersion: GUEST_ANSWER_EVIDENCE_VERSION,
  promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
  answerHash: hash,
  systemPromptHash: 'b'.repeat(64),
  evidenceSetHash: 'c'.repeat(64),
  routeConfigurationVersion: 'route-v1',
  system: { staticPart: 'Static prompt', dynamicPart: 'Dynamic prompt' },
  sources: [
    {
      sourceId: 'knowledge:hours',
      kind: 'KNOWLEDGE',
      label: 'Hours',
      rank: 0,
      snapshot: '{"content":"Open until 5 PM"}',
      snapshotHash: 'd'.repeat(64),
    },
  ],
}

describe('guest answer claim attribution', () => {
  it('binds exact spans and frozen sources while reporting threshold-free metrics', () => {
    const answer = 'The museum closes at 5 PM. Have a great visit!'
    const result = createGuestAnswerAttribution({
      answer,
      evidence,
      evaluator: {
        provider: 'test-provider',
        model: 'test-model',
        configurationVersion: 'eval-config-v1',
        promptVersion: 'claim-attribution-v1',
      },
      claims: [
        {
          start: 0,
          end: 26,
          text: 'The museum closes at 5 PM.',
          support: 'SUPPORTED',
          sourceIds: ['knowledge:hours'],
          rationale: 'The frozen hours source states the closing time.',
        },
        {
          start: 27,
          end: answer.length,
          text: 'Have a great visit!',
          support: 'NON_FACTUAL',
          sourceIds: [],
          rationale: 'A courtesy statement is not a factual venue claim.',
        },
      ],
    })

    expect(result).toMatchObject({
      answerHash: hash,
      evidenceSetHash: 'c'.repeat(64),
      metrics: {
        claimCount: 2,
        supportedCount: 1,
        unsupportedCount: 0,
        uncertainCount: 0,
        nonFactualCount: 1,
        supportRate: 1,
      },
    })
    expect(result).not.toHaveProperty('passed')
  })

  it('rejects altered spans, unknown sources, overlaps, and unsupported bare support', () => {
    const base = {
      answer: 'Open until five.',
      evidence,
      evaluator: {
        provider: 'test-provider',
        model: 'test-model',
        configurationVersion: 'eval-config-v1',
        promptVersion: 'claim-attribution-v1',
      },
    }
    expect(() =>
      createGuestAnswerAttribution({
        ...base,
        claims: [
          {
            start: 0,
            end: 4,
            text: 'Closed',
            support: 'UNCERTAIN',
            sourceIds: [],
            rationale: 'Mismatch.',
          },
        ],
      }),
    ).toThrow(/exact response span/)
    expect(() =>
      createGuestAnswerAttribution({
        ...base,
        claims: [
          {
            start: 0,
            end: 16,
            text: 'Open until five.',
            support: 'SUPPORTED',
            sourceIds: ['knowledge:missing'],
            rationale: 'Unknown source.',
          },
        ],
      }),
    ).toThrow(/outside the frozen source set/)
    expect(() =>
      createGuestAnswerAttribution({
        ...base,
        claims: [
          {
            start: 0,
            end: 4,
            text: 'Open',
            support: 'SUPPORTED',
            sourceIds: [],
            rationale: 'No source.',
          },
        ],
      }),
    ).toThrow(/requires at least one evidence source/)
  })
})

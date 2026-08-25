import { describe, expect, it } from 'vitest'

import {
  buildGuestAnswerEvidenceBundle,
  createVerifiedGuestAnswerAttribution,
  verifyGuestAnswerEvidenceBundle,
} from './guest-answer-evidence'

describe('guest answer evidence', () => {
  it('freezes exact prompts and canonical source snapshots with stable hashes', () => {
    const first = buildGuestAnswerEvidenceBundle({
      assistantResponse: 'The museum closes at 5 PM.',
      staticSystemPrompt: 'You are the venue guide.',
      dynamicSystemPrompt: 'KNOWLEDGE BASE: Hours: Open until 5 PM.',
      routeConfigurationVersion: 'route-v3',
      sources: [
        {
          sourceId: 'knowledge:hours',
          kind: 'KNOWLEDGE',
          label: 'Hours',
          rank: 0,
          snapshot: { title: 'Hours', content: 'Open until 5 PM.' },
        },
      ],
    })
    const reordered = buildGuestAnswerEvidenceBundle({
      assistantResponse: 'The museum closes at 5 PM.',
      staticSystemPrompt: 'You are the venue guide.',
      dynamicSystemPrompt: 'KNOWLEDGE BASE: Hours: Open until 5 PM.',
      routeConfigurationVersion: 'route-v3',
      sources: [
        {
          sourceId: 'knowledge:hours',
          kind: 'KNOWLEDGE',
          label: 'Hours',
          rank: 0,
          snapshot: { content: 'Open until 5 PM.', title: 'Hours' },
        },
      ],
    })

    expect(reordered).toEqual(first)
    expect(
      verifyGuestAnswerEvidenceBundle({
        assistantResponse: first.system.dynamicPart,
        evidence: first,
      }),
    ).toBe(false)
    expect(
      verifyGuestAnswerEvidenceBundle({
        assistantResponse: 'The museum closes at 5 PM.',
        evidence: first,
      }),
    ).toBe(true)
  })

  it('detects response, source, prompt, and evidence-set tampering', () => {
    const evidence = buildGuestAnswerEvidenceBundle({
      assistantResponse: 'Open today.',
      staticSystemPrompt: 'Static.',
      dynamicSystemPrompt: 'Dynamic.',
      sources: [
        {
          sourceId: 'venue:venue-1',
          kind: 'VENUE_PROFILE',
          label: 'Museum',
          snapshot: { name: 'Museum' },
        },
      ],
    })
    expect(verifyGuestAnswerEvidenceBundle({ assistantResponse: 'Changed.', evidence })).toBe(false)
    expect(
      verifyGuestAnswerEvidenceBundle({
        assistantResponse: 'Open today.',
        evidence: {
          ...evidence,
          sources: [{ ...evidence.sources[0]!, snapshot: '{"name":"Other"}' }],
        },
      }),
    ).toBe(false)
    expect(
      verifyGuestAnswerEvidenceBundle({
        assistantResponse: 'Open today.',
        evidence: { ...evidence, system: { ...evidence.system, dynamicPart: 'Changed.' } },
      }),
    ).toBe(false)
  })

  it('refuses claim annotations until the exact answer and evidence hashes verify', () => {
    const evidence = buildGuestAnswerEvidenceBundle({
      assistantResponse: 'Open today.',
      staticSystemPrompt: 'Static.',
      dynamicSystemPrompt: 'Dynamic.',
      sources: [
        {
          sourceId: 'venue:venue-1',
          kind: 'VENUE_PROFILE',
          label: 'Museum',
          snapshot: { name: 'Museum' },
        },
      ],
    })
    const input = {
      answer: 'Open today.',
      evidence,
      evaluator: {
        provider: 'reviewer',
        model: 'reviewer-v1',
        configurationVersion: 'config-v1',
        promptVersion: 'attribution-v1',
      },
      claims: [
        {
          start: 0,
          end: 11,
          text: 'Open today.',
          support: 'SUPPORTED' as const,
          sourceIds: ['venue:venue-1'],
          rationale: 'The venue profile supports this claim.',
        },
      ],
    }
    expect(createVerifiedGuestAnswerAttribution(input).metrics.supportRate).toBe(1)
    expect(() =>
      createVerifiedGuestAnswerAttribution({ ...input, answer: 'Closed today.' }),
    ).toThrow(/content-address verification/)
  })
})

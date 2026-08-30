import { NOOP_AI_BUDGET_GATE, setAnthropicClientForTesting } from '@pathfinder/ai'
import { buildGuestAnswerEvidenceBundle } from '@pathfinder/contracts/guest-answer-attribution-node'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GUEST_ANSWER_ATTRIBUTION_EVALUATOR_PROMPT_VERSION,
  runProviderBackedGuestAnswerAttributionEvaluation,
} from './guest-answer-attribution'

const answer = 'The museum closes at 5 PM.'
const evidence = buildGuestAnswerEvidenceBundle({
  assistantResponse: answer,
  staticSystemPrompt: 'You are the venue guide.',
  dynamicSystemPrompt: 'Use the supplied venue facts.',
  routeConfigurationVersion: 'route-v3',
  sources: [
    {
      sourceId: 'knowledge:hours',
      kind: 'KNOWLEDGE',
      label: 'Hours',
      snapshot: { title: 'Hours', content: 'The museum closes at 5 PM.' },
    },
  ],
})

afterEach(() => setAnthropicClientForTesting(null))

describe('provider-backed guest answer attribution evaluation', () => {
  it('returns a verified, threshold-free attribution through governed routing', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            claims: [
              {
                start: 0,
                end: answer.length,
                text: answer,
                support: 'SUPPORTED',
                sourceIds: ['knowledge:hours'],
                rationale: 'The exact hours source supports the answer.',
              },
            ],
          }),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 40 },
    })
    setAnthropicClientForTesting({ messages: { create } })
    const onBeforeFirstDispatch = vi.fn().mockResolvedValue(undefined)
    const usageSink = vi.fn().mockResolvedValue(undefined)

    const result = await runProviderBackedGuestAnswerAttributionEvaluation({
      answer,
      evidence,
      admissionGuard: async () => undefined,
      budgetGate: NOOP_AI_BUDGET_GATE,
      usageSink,
      invocationId: '11111111-1111-4111-8111-111111111111',
      onBeforeFirstDispatch,
    })

    expect(result.attribution).toMatchObject({
      answerHash: evidence.answerHash,
      evidenceSetHash: evidence.evidenceSetHash,
      evaluator: {
        provider: 'anthropic',
        promptVersion: GUEST_ANSWER_ATTRIBUTION_EVALUATOR_PROMPT_VERSION,
      },
      metrics: { claimCount: 1, supportedCount: 1, supportRate: 1 },
    })
    expect(result.attribution).not.toHaveProperty('passed')
    expect(result.route).toMatchObject({
      capability: 'BACKGROUND_ANALYSIS',
      workloadId: 'guest-answer-attribution-evaluation',
      fallbackUsed: false,
    })
    expect(onBeforeFirstDispatch).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ requestType: 'guest-answer-attribution-evaluation' }),
    )
  })

  it('rejects tampered evidence before any provider dispatch', async () => {
    const create = vi.fn()
    setAnthropicClientForTesting({ messages: { create } })
    await expect(
      runProviderBackedGuestAnswerAttributionEvaluation({
        answer,
        evidence: {
          ...evidence,
          sources: [{ ...evidence.sources[0]!, snapshot: '{"content":"changed"}' }],
        },
        admissionGuard: async () => undefined,
        budgetGate: NOOP_AI_BUDGET_GATE,
        usageSink: async () => undefined,
      }),
    ).rejects.toThrow(/content-address verification/)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects invented sources and invalid exact spans as structured provider failures', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            claims: [
              {
                start: 0,
                end: 3,
                text: 'Wrong',
                support: 'SUPPORTED',
                sourceIds: ['invented'],
                rationale: 'Invalid provider output.',
              },
            ],
          }),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 40 },
    })
    setAnthropicClientForTesting({ messages: { create } })
    await expect(
      runProviderBackedGuestAnswerAttributionEvaluation({
        answer,
        evidence,
        admissionGuard: async () => undefined,
        budgetGate: NOOP_AI_BUDGET_GATE,
        usageSink: async () => undefined,
      }),
    ).rejects.toThrow(/does not match the exact response span/)
  })
})

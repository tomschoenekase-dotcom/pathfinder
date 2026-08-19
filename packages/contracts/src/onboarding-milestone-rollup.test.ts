import { describe, expect, it } from 'vitest'

import { buildOnboardingMilestoneRollup } from './onboarding-milestone-rollup'

const from = new Date('2026-08-18T00:00:00.000Z')
const to = new Date('2026-08-19T00:00:00.000Z')

function event(
  id: string,
  eventType: Parameters<typeof buildOnboardingMilestoneRollup>[0]['events'][number]['eventType'],
  minute: number,
  category: string | null = null,
  durationMs: number | null = null,
) {
  return {
    id,
    eventType,
    occurredAt: new Date(from.getTime() + minute * 60_000),
    category,
    durationMs,
  }
}

describe('onboarding milestone rollup', () => {
  it('derives bounded rates and durations only from durable milestone events', () => {
    const result = buildOnboardingMilestoneRollup({
      from,
      to,
      eventLimit: 1000,
      truncated: false,
      events: [
        event('1', 'INVITATION_STARTED', 1),
        event('2', 'FIRST_USEFUL_MATERIAL', 4),
        event('3', 'UPLOAD_FAILED', 5),
        event('4', 'QUESTION_ROUTED', 6),
        event('5', 'QUESTION_ANSWERED', 9, null, 180_000),
        event('6', 'REVIEWABLE_PACKAGE', 12),
        event('7', 'QA_RESULT', 13, 'SAFETY:PASSED'),
        event('8', 'QA_RESULT', 14, 'SAFETY:FAILED'),
        event('9', 'CORRECTION_RECORDED', 15, 'ACCESSIBILITY'),
        event('10', 'CORRECTION_RECORDED', 16, 'ACCESSIBILITY'),
      ],
    })

    expect(result.timeToFirstUsefulMaterial).toMatchObject({ valueMs: 180_000, denominator: 1 })
    expect(result.timeToReviewablePackage).toMatchObject({ valueMs: 660_000, denominator: 1 })
    expect(result.uploadFailureRate).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(result.clientQuestionResponse).toMatchObject({
      averageMs: 180_000,
      answered: 1,
      routed: 1,
    })
    expect(result.qaPassRateByCategory).toEqual([
      {
        category: 'SAFETY',
        rate: expect.objectContaining({ numerator: 1, denominator: 2, rate: 0.5 }),
      },
    ])
    expect(result.repeatedCorrectionCategories).toEqual([{ category: 'ACCESSIBILITY', count: 2 }])
  })

  it('reports null rather than a fabricated zero when a denominator is absent', () => {
    const result = buildOnboardingMilestoneRollup({
      from,
      to,
      eventLimit: 1000,
      truncated: false,
      events: [],
    })
    expect(result.timeToFirstUsefulMaterial.valueMs).toBeNull()
    expect(result.uploadFailureRate).toMatchObject({ denominator: 0, rate: null })
    expect(result.clientQuestionResponse.responseRate).toMatchObject({ denominator: 0, rate: null })
  })

  it('uses a half-open time window and deterministic ordering', () => {
    const result = buildOnboardingMilestoneRollup({
      from,
      to,
      eventLimit: 2,
      truncated: true,
      events: [
        { ...event('outside', 'UPLOAD_FAILED', 1440), occurredAt: to },
        event('inside', 'UPLOAD_FAILED', 1439),
      ],
    })
    expect(result.window).toMatchObject({ observedEvents: 1, truncated: true, eventLimit: 2 })
  })
})

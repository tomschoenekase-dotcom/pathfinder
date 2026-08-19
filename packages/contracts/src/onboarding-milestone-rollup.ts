import { z } from 'zod'

import { OnboardingMilestoneEventType } from './onboarding-milestones'

export const ONBOARDING_MILESTONE_ROLLUP_VERSION =
  'torchiko-onboarding-milestone-rollup-v1' as const

export const OnboardingMilestoneRollupEvent = z
  .object({
    id: z.string().min(1),
    eventType: OnboardingMilestoneEventType,
    occurredAt: z.date(),
    category: z.string().max(100).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  })
  .strict()

const boundedCount = z.object({
  value: z.number().int().nonnegative(),
  observedEvents: z.number().int().nonnegative(),
  missingDataBehavior: z.string().min(1),
})

const boundedRate = z.object({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1).nullable(),
  denominatorDefinition: z.string().min(1),
  missingDataBehavior: z.string().min(1),
})

const boundedDuration = z.object({
  valueMs: z.number().int().nonnegative().nullable(),
  denominator: z.number().int().nonnegative(),
  denominatorDefinition: z.string().min(1),
  missingDataBehavior: z.string().min(1),
})

export const OnboardingMilestoneRollup = z
  .object({
    version: z.literal(ONBOARDING_MILESTONE_ROLLUP_VERSION),
    window: z.object({
      from: z.date(),
      to: z.date(),
      truncated: z.boolean(),
      eventLimit: z.number().int().positive(),
      observedEvents: z.number().int().nonnegative(),
    }),
    timeToFirstUsefulMaterial: boundedDuration,
    timeToReviewablePackage: boundedDuration,
    clientQuestionResponse: z.object({
      averageMs: z.number().int().nonnegative().nullable(),
      answered: z.number().int().nonnegative(),
      routed: z.number().int().nonnegative(),
      responseRate: boundedRate,
      missingDataBehavior: z.string().min(1),
    }),
    uploadFailureRate: boundedRate,
    processingFailureRate: boundedRate,
    qaPassRateByCategory: z.array(
      z.object({ category: z.string().min(1).max(100), rate: boundedRate }),
    ),
    humanInterventions: boundedCount,
    repeatedCorrectionCategories: z.array(
      z.object({ category: z.string().min(1).max(100), count: z.number().int().min(2) }),
    ),
    postLaunchMissingKnowledge: boundedCount,
  })
  .strict()
export type OnboardingMilestoneRollup = z.infer<typeof OnboardingMilestoneRollup>

type Event = z.infer<typeof OnboardingMilestoneRollupEvent>

const noEvent = 'Returns null, never zero, when the required durable milestone is absent.'

function durationBetween(
  events: Event[],
  startType: Event['eventType'],
  endType: Event['eventType'],
) {
  const start = events.find((event) => event.eventType === startType)
  const end = start
    ? events.find(
        (event) =>
          event.eventType === endType && event.occurredAt.getTime() >= start.occurredAt.getTime(),
      )
    : undefined
  return {
    valueMs: start && end ? end.occurredAt.getTime() - start.occurredAt.getTime() : null,
    denominator: start && end ? 1 : 0,
    denominatorDefinition: `One exact venue with ${startType} followed by ${endType} inside the selected window.`,
    missingDataBehavior: noEvent,
  }
}

function rate(numerator: number, denominator: number, definition: string) {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    denominatorDefinition: definition,
    missingDataBehavior: 'Returns null, never zero, when the denominator has no durable events.',
  }
}

export function buildOnboardingMilestoneRollup(input: {
  events: Event[]
  from: Date
  to: Date
  eventLimit: number
  truncated: boolean
}): OnboardingMilestoneRollup {
  if (input.to.getTime() <= input.from.getTime()) throw new Error('Rollup window must be positive')
  const events = input.events
    .map((event) => OnboardingMilestoneRollupEvent.parse(event))
    .filter(
      (event) =>
        event.occurredAt.getTime() >= input.from.getTime() &&
        event.occurredAt.getTime() < input.to.getTime(),
    )
    .sort(
      (left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
    )
  const count = (type: Event['eventType']) =>
    events.filter((event) => event.eventType === type).length
  const routed = count('QUESTION_ROUTED')
  const answeredEvents = events.filter((event) => event.eventType === 'QUESTION_ANSWERED')
  const answeredDurations = answeredEvents.flatMap((event) =>
    event.durationMs === null ? [] : [event.durationMs],
  )
  const uploadFailed = count('UPLOAD_FAILED')
  const usefulMaterial = count('FIRST_USEFUL_MATERIAL')
  const processingFailed = count('PROCESSING_FAILED')
  const qa = events
    .filter((event) => event.eventType === 'QA_RESULT')
    .map((event) => {
      const match = /^(.*):(PASSED|FAILED)$/u.exec(event.category ?? '')
      return {
        category: match?.[1] || 'UNCLASSIFIED',
        passed: match?.[2] === 'PASSED',
      }
    })
  const qaCategories = [...new Set(qa.map((event) => event.category))].sort()
  const correctionCounts = new Map<string, number>()
  for (const event of events.filter((candidate) => candidate.eventType === 'CORRECTION_RECORDED')) {
    const category = event.category ?? 'UNCLASSIFIED'
    correctionCounts.set(category, (correctionCounts.get(category) ?? 0) + 1)
  }

  return OnboardingMilestoneRollup.parse({
    version: ONBOARDING_MILESTONE_ROLLUP_VERSION,
    window: {
      from: input.from,
      to: input.to,
      truncated: input.truncated,
      eventLimit: input.eventLimit,
      observedEvents: events.length,
    },
    timeToFirstUsefulMaterial: durationBetween(
      events,
      'INVITATION_STARTED',
      'FIRST_USEFUL_MATERIAL',
    ),
    timeToReviewablePackage: durationBetween(events, 'INVITATION_STARTED', 'REVIEWABLE_PACKAGE'),
    clientQuestionResponse: {
      averageMs:
        answeredDurations.length === 0
          ? null
          : Math.round(
              answeredDurations.reduce((total, duration) => total + duration, 0) /
                answeredDurations.length,
            ),
      answered: answeredEvents.length,
      routed,
      responseRate: rate(
        Math.min(answeredEvents.length, routed),
        routed,
        'Durable QUESTION_ROUTED events for this venue and window.',
      ),
      missingDataBehavior:
        'Average excludes answered events whose immutable response duration is unavailable.',
    },
    uploadFailureRate: rate(
      uploadFailed,
      uploadFailed + usefulMaterial,
      'Terminal upload outcomes represented by UPLOAD_FAILED plus FIRST_USEFUL_MATERIAL events.',
    ),
    processingFailureRate: rate(
      processingFailed,
      processingFailed + usefulMaterial,
      'Observed processing failures plus successfully verified useful-material events.',
    ),
    qaPassRateByCategory: qaCategories.map((category) => {
      const categoryEvents = qa.filter((event) => event.category === category)
      const passed = categoryEvents.filter((event) => event.passed).length
      return {
        category,
        rate: rate(passed, categoryEvents.length, `QA_RESULT events categorized as ${category}.`),
      }
    }),
    humanInterventions: {
      value: count('HUMAN_INTERVENTION'),
      observedEvents: count('HUMAN_INTERVENTION'),
      missingDataBehavior:
        'No matching durable event is reported as zero within the explicit window.',
    },
    repeatedCorrectionCategories: [...correctionCounts.entries()]
      .filter(([, value]) => value >= 2)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, value]) => ({ category, count: value })),
    postLaunchMissingKnowledge: {
      value: count('POST_LAUNCH_MISSING_KNOWLEDGE'),
      observedEvents: count('POST_LAUNCH_MISSING_KNOWLEDGE'),
      missingDataBehavior:
        'No matching durable event is reported as zero within the explicit window.',
    },
  })
}

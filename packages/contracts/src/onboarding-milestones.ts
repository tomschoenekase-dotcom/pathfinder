import { z } from 'zod'

export const ONBOARDING_MILESTONE_SCHEMA_VERSION = 1 as const

export const OnboardingMilestoneEventType = z.enum([
  'INVITATION_STARTED',
  'FIRST_USEFUL_MATERIAL',
  'QUESTION_ROUTED',
  'QUESTION_ANSWERED',
  'REVIEWABLE_PACKAGE',
  'QA_RESULT',
  'HUMAN_INTERVENTION',
  'RELEASED',
  'STALE_FACT',
  'POST_LAUNCH_MISSING_KNOWLEDGE',
  'UPLOAD_FAILED',
  'PROCESSING_FAILED',
  'CORRECTION_RECORDED',
])
export type OnboardingMilestoneEventType = z.infer<typeof OnboardingMilestoneEventType>

export const OnboardingMilestoneActorType = z.enum(['CLIENT', 'OPERATOR', 'AGENT', 'SYSTEM'])
export type OnboardingMilestoneActorType = z.infer<typeof OnboardingMilestoneActorType>

/** Sanitized domain-event identity. Raw prompts, conversations, and client material are excluded. */
export const OnboardingMilestoneIdentity = z
  .object({
    eventType: OnboardingMilestoneEventType,
    eventVersion: z.literal(ONBOARDING_MILESTONE_SCHEMA_VERSION),
    idempotencyKey: z.string().trim().min(1).max(191),
    occurredAt: z.string().datetime({ offset: true }),
    actorType: OnboardingMilestoneActorType,
    actorId: z.string().trim().min(1).max(191).nullable(),
    sourceType: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9_]+$/u),
    sourceId: z.string().trim().min(1).max(191),
    sourceRevision: z.string().trim().min(1).max(191).nullable(),
    category: z.string().trim().min(1).max(100).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actorType !== 'SYSTEM' && value.actorId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actorId'],
        message: 'Non-system milestone actors require an identifier',
      })
    }
  })
export type OnboardingMilestoneIdentity = z.infer<typeof OnboardingMilestoneIdentity>

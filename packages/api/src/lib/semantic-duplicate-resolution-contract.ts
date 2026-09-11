import { z } from 'zod'

import { SemanticUpdaterDesiredKnowledge } from './semantic-venue-updater'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

function plainObject<T extends z.ZodRawShape>(shape: T) {
  return z
    .custom<
      Record<string, unknown>
    >((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'Expected a plain object')
    .pipe(z.object(shape).strict())
}

const enabledDesiredKnowledge = z
  .custom<Record<string, unknown>>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    'Expected a plain desired-knowledge object',
  )
  .pipe(SemanticUpdaterDesiredKnowledge)
  .superRefine((value, context) => {
    if (!value.isEnabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isEnabled'],
        message: 'Disabled guidance cannot resolve a duplicate fulfillment outcome.',
      })
    }
  })

export const SemanticDuplicateResolutionInput = plainObject({
  operationId: z.string().uuid(),
  tenantId: z.string().trim().min(1).max(191),
  venueId: z.string().trim().min(1).max(191),
  proposalId: z.string().uuid(),
  expectedProposalUpdatedAt: z.string().datetime(),
  expectedPreviewHash: sha256,
  relation: z.enum(['NEW_FACT', 'CORRECTS', 'SUPERSEDES']),
  desired: enabledDesiredKnowledge,
  resolutionNote: z.string().trim().min(1).max(2000),
})

export type SemanticDuplicateResolutionInputValue = z.infer<typeof SemanticDuplicateResolutionInput>

import { createHash } from 'node:crypto'

import { z } from 'zod'
export { hashSemanticCanonicalKnowledgeTarget as hashSemanticConflictTarget } from '@pathfinder/contracts'

import { SemanticUpdaterDesiredKnowledge } from './semantic-venue-updater'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

function plainObject<T extends z.ZodRawShape>(shape: T) {
  return z
    .custom<
      Record<string, unknown>
    >((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'Expected a plain object')
    .pipe(z.object(shape).strict())
}

const desiredKnowledge = z
  .custom<
    Record<string, unknown>
  >((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'Expected a plain desired-knowledge object')
  .pipe(SemanticUpdaterDesiredKnowledge)

export const SemanticConflictResolutionInput = plainObject({
  operationId: z.string().uuid(),
  tenantId: z.string().trim().min(1).max(191),
  venueId: z.string().trim().min(1).max(191),
  proposalId: z.string().uuid(),
  expectedProposalUpdatedAt: z.string().datetime(),
  expectedPreviewHash: sha256,
  questionId: z.string().trim().min(1).max(191),
  expectedQuestionUpdatedAt: z.string().datetime(),
  expectedAnsweredAt: z.string().datetime(),
  expectedAnswerHash: sha256,
  relation: z.enum(['CORRECTS', 'SUPERSEDES']),
  desired: desiredKnowledge,
  replacementDesired: desiredKnowledge.optional(),
  outcome: z.enum(['KEEP_CANONICAL', 'PROPOSE_REPLACEMENT']),
  resolutionNote: z.string().trim().min(1).max(2000),
}).superRefine((value, context) => {
  if (value.outcome === 'PROPOSE_REPLACEMENT' && !value.replacementDesired) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replacementDesired'],
      message: 'A replacement outcome requires explicit replacement content.',
    })
  }
  if (value.outcome === 'KEEP_CANONICAL' && value.replacementDesired) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replacementDesired'],
      message: 'A keep-canonical outcome cannot include replacement content.',
    })
  }
})

export type SemanticConflictResolutionInputValue = z.infer<typeof SemanticConflictResolutionInput>

export function hashSemanticConflictAnswer(answer: string): string {
  return createHash('sha256').update(answer).digest('hex')
}

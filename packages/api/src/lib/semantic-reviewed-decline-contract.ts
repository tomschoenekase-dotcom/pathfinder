import { z } from 'zod'

function plainObject<T extends z.ZodRawShape>(shape: T) {
  return z
    .custom<
      Record<string, unknown>
    >((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'Expected a plain object')
    .pipe(z.object(shape).strict())
}

/** Exact human re-attestation of a source-bound proposal decline. */
export const SemanticReviewedDeclineInput = plainObject({
  operationId: z.string().uuid(),
  tenantId: z.string().trim().min(1).max(191),
  venueId: z.string().trim().min(1).max(191),
  proposalId: z.string().uuid(),
  expectedProposalUpdatedAt: z.string().datetime(),
  resolutionNote: z.string().trim().min(1).max(2000),
})

export type SemanticReviewedDeclineInputValue = z.infer<typeof SemanticReviewedDeclineInput>

import { createHash } from 'node:crypto'

import { z } from 'zod'

function plainObject<T extends z.ZodRawShape>(shape: T) {
  return z
    .custom<
      Record<string, unknown>
    >((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'Expected a plain object')
    .pipe(z.object(shape).strict())
}

export const SemanticCanonicalKnowledgeTarget = plainObject({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  content: z.string(),
  isEnabled: z.boolean(),
  humanConfirmedAt: z.date().nullable(),
  authorship: z.string(),
  sourceType: z.string(),
})

export function hashSemanticCanonicalKnowledgeTarget(
  rawTarget: z.input<typeof SemanticCanonicalKnowledgeTarget>,
): string {
  const target = SemanticCanonicalKnowledgeTarget.parse(rawTarget)
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: target.id,
        title: target.title,
        category: target.category,
        content: target.content,
        isEnabled: target.isEnabled,
        humanConfirmedAt: target.humanConfirmedAt?.toISOString() ?? null,
        authorship: target.authorship,
        sourceType: target.sourceType,
      }),
    )
    .digest('hex')
}
